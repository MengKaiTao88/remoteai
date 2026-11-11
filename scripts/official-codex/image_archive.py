"""Retain evidenced clipboard images independently of the operating system's Temp cleanup."""
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import uuid
from pathlib import Path

MAX_BYTES = 20 * 1024 * 1024
_workers = set()
_worker_lock = threading.Lock()


def image_type(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


class ImageArchive:
    def __init__(self, home, temporary=None):
        self.root = Path(home) / 'remoteai-image-archive'
        self.temporary = Path(temporary or tempfile.gettempdir()).resolve()

    def location(self, thread_id, source):
        thread = str(uuid.UUID(thread_id))
        path = Path(source)
        # Only app clipboard files in the actual Temp directory need this backup.
        # Project output files and immutable gateway uploads keep their existing owners.
        if not path.name.startswith('codex-clipboard-') or path.parent.resolve() != self.temporary:
            raise ValueError('Not a clipboard image')
        resolved = path.resolve()
        if resolved.parent != self.temporary:
            raise ValueError('Clipboard image escaped Temp')
        identifier = hashlib.sha256(str(resolved).encode()).hexdigest()
        return resolved, self.root / thread / identifier

    def capture(self, thread_id, source):
        temporary = None
        try:
            original, target = self.location(thread_id, source)
            if target.is_file():
                return
            with original.open('rb') as stream:
                data = stream.read(MAX_BYTES + 1)
            if not 0 < len(data) <= MAX_BYTES or not image_type(data):
                return
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.pending-', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
            os.replace(temporary, target)
        except (OSError, ValueError, RuntimeError):
            # A missing old image must never prevent its text history from loading.
            pass
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def preview(self, thread_id, source, identifier):
        original, target = self.location(thread_id, source)
        if hashlib.sha256(str(original).encode()).hexdigest() != identifier:
            raise KeyError('Image does not belong to this reference')
        with target.open('rb') as stream:
            data = stream.read(MAX_BYTES + 1)
        mime = image_type(data)
        if not 0 < len(data) <= MAX_BYTES or not mime:
            raise KeyError('Archived image is unavailable')
        return {'previewBytes': data, 'previewMime': mime,
                'previewSha256': hashlib.sha256(data).hexdigest(), 'name': original.name}, 'archive'


def paths(items):
    if isinstance(items, dict):
        items = items.values()
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get('type') in ('userMessage', 'steeringUserMessage') and ('content' in item or 'input' in item):
            content = item.get('content') or item.get('input') or []
        else:
            content = item.get('attachments') or []
        if isinstance(content, list):
            for attachment in content:
                if isinstance(attachment, dict) and attachment.get('type') == 'localImage':
                    source = attachment.get('path')
                    if isinstance(source, str):
                        yield source


def capture_history(home, thread_id, state):
    archive = ImageArchive(home)
    for turn in turns(state):
        items = turn.get('items') or []
        if isinstance(items, (list, dict)):
            for source in paths(items):
                archive.capture(thread_id, source)


def turns(state):
    value = state.get('turns') or []
    return value.values() if isinstance(value, dict) else value


def retain_indexed_images(home, cursor=0):
    """Incrementally inspect newly indexed user messages, without changing SQLite."""
    from contextlib import closing
    from native_history import _open_index
    with closing(_open_index(home)) as connection:
        newest = connection.execute('SELECT COALESCE(MAX(rowid),0) FROM thread_items').fetchone()[0]
        if newest < cursor:
            cursor = 0
        rows = connection.execute("SELECT rowid,thread_id,item_json FROM thread_items "
                                  "WHERE rowid>? AND rowid<=? AND item_type IN ('userMessage','steeringUserMessage') "
                                  "ORDER BY rowid LIMIT 256", (cursor, newest)).fetchall()
    archive = ImageArchive(home)
    for row in rows:
        try:
            for source in paths([json.loads(row['item_json'])]):
                archive.capture(row['thread_id'], source)
        except (ValueError, TypeError):
            continue
    return rows[-1]['rowid'] if len(rows) == 256 else newest


def start_archive_worker(home):
    key = str(Path(home).resolve())
    with _worker_lock:
        if key in _workers:
            return
        _workers.add(key)

    def retain():
        cursor = 0
        while True:
            try:
                previous = cursor
                cursor = retain_indexed_images(home, cursor)
                # Drain a large initial backlog in bounded batches off request threads.
                if cursor != previous:
                    continue
            except (OSError, sqlite3.Error, ValueError, TypeError, RuntimeError):
                pass
            threading.Event().wait(60)

    threading.Thread(target=retain, name='remoteai-image-retention', daemon=True).start()


def install(bridge_class):
    if getattr(bridge_class.desktop_image_preview, '_remoteai_archive', False):
        return
    annotate = bridge_class._annotate_upload_attachments
    preview = bridge_class.desktop_image_preview
    initialize = bridge_class.__init__

    def initialize_archive(bridge, *args, **kwargs):
        initialize(bridge, *args, **kwargs)
        if bridge.host == 'local':
            start_archive_worker(bridge.store.home)

    def annotate_images(bridge, session, rows):
        if bridge.host == 'local':
            archive = ImageArchive(bridge.store.home)
            for source in paths(rows):
                archive.capture(session.id, source)
        return annotate(bridge, session, rows)

    def preview_image(bridge, thread_id, identifier):
        try:
            return preview(bridge, thread_id, identifier)
        except KeyError as missing:
            if bridge.host != 'local':
                raise
            session = bridge.session(thread_id, attach=False)
            # Cached bytes grant no authority: recheck current chat membership.
            with session.condition:
                state = (session.state if session.connected else session.history_state or session.state) or {}
                sources = [source for turn in turns(state)
                           for source in paths(turn.get('items') or [])]
            archive = ImageArchive(bridge.store.home)
            for source in sources:
                try:
                    return archive.preview(thread_id, source, identifier)
                except (OSError, KeyError, ValueError, RuntimeError):
                    continue
            raise missing

    preview_image._remoteai_archive = True
    bridge_class.__init__ = initialize_archive
    bridge_class._annotate_upload_attachments = annotate_images
    bridge_class.desktop_image_preview = preview_image
