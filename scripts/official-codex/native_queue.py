"""Read the official desktop's queue without submitting, deleting or replaying messages."""
import json
import sqlite3
from contextlib import closing
from functools import wraps
from pathlib import Path
from uuid import UUID

MAX_MESSAGES = 100
MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
MAX_DESKTOP_STATE_BYTES = 16 * 1024 * 1024


def server_queue(home, thread_id):
    database = home / 'queue_1.sqlite'
    if not database.exists():
        return None
    if database.is_symlink() or database.resolve().parent != home:
        raise ValueError('Queue storage is not local')
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=0.2)) as connection:
        connection.execute('PRAGMA query_only=ON')
        rows = connection.execute(
            'SELECT substr(id,1,201),CASE WHEN length(CAST(payload_json AS BLOB))<=? '
            'THEN payload_json END,created_at_ms FROM queued_items WHERE thread_id=? '
            'ORDER BY queue_order LIMIT ?', (MAX_PAYLOAD_BYTES, thread_id, MAX_MESSAGES + 1)).fetchall()
        if len(rows) > MAX_MESSAGES:
            raise ValueError('Too many queued messages')
        messages = []
        for identifier, payload, created_at in rows:
            if not isinstance(identifier, str) or len(identifier) > 200 or not isinstance(payload, str):
                raise ValueError('Invalid queued message')
            value = json.loads(payload)
            if not isinstance(value, dict):
                raise ValueError('Invalid queued payload')
            inputs = value.get('input')
            if not isinstance(inputs, list):
                raise ValueError('Unsupported queued input')
            text = '\n'.join(part['text'] for part in inputs if isinstance(part, dict)
                             and part.get('type') == 'text' and isinstance(part.get('text'), str))
            messages.append({'id': identifier, 'text': text[:1000],
                             'imageCount': sum(part.get('type') in ('image', 'localImage')
                                               for part in inputs if isinstance(part, dict)),
                             'createdAt': created_at})
    return messages


def desktop_queue(home, thread_id):
    path = home / '.codex-global-state.json'
    if not path.exists():
        return None
    if path.is_symlink() or path.resolve().parent != home:
        raise ValueError('Queue storage is not local')
    with path.open('rb') as stream:
        data = stream.read(MAX_DESKTOP_STATE_BYTES + 1)
    if len(data) > MAX_DESKTOP_STATE_BYTES:
        raise ValueError('Queue storage exceeds the bounded read size')
    state = json.loads(data)
    if not isinstance(state, dict):
        raise ValueError('Invalid desktop state')
    queues = state.get('queued-follow-ups', {})
    if not isinstance(queues, dict):
        raise ValueError('Unsupported desktop queue schema')
    queue = queues.get(thread_id, [])
    if not isinstance(queue, list) or len(queue) > MAX_MESSAGES:
        raise ValueError('Invalid desktop queue')
    messages = []
    for item in queue:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or len(item['id']) > 200:
            raise ValueError('Invalid queued message identity')
        options = item.get('submissionOptions') or {}
        if not isinstance(options, dict):
            raise ValueError('Invalid submission metadata')
        if options.get('executionHostId', 'local') != 'local':
            continue
        if not isinstance(item.get('text'), str):
            raise ValueError('Invalid queued message text')
        context = item.get('context') or {}
        if not isinstance(context, dict):
            raise ValueError('Invalid queued context')
        images = context.get('imageAttachments') or []
        if not isinstance(images, list):
            raise ValueError('Invalid queued images')
        messages.append({'id': item['id'], 'text': item['text'][:1000],
                         'imageCount': len(images), 'createdAt': item.get('createdAt')})
    return messages


def snapshot(home, thread_id):
    UUID(thread_id)
    home = Path(home).resolve()
    desktop = desktop_queue(home, thread_id)
    server = server_queue(home, thread_id)
    if desktop is None and server is None:
        return None
    # The same identity can migrate between stores; identical text alone is never an identity.
    messages = {item['id']: item for item in (desktop or [])}
    for item in server or []:
        messages[item['id']] = item
    if len(messages) > MAX_MESSAGES:
        raise ValueError('Too many queued messages')
    return list(messages.values())


def install(bridge_class):
    original = bridge_class.view
    if getattr(original, '_remoteai_native_queue', False):
        return

    @wraps(original)
    def view(bridge, thread_id, *args, **kwargs):
        result = original(bridge, thread_id, *args, **kwargs)
        if bridge.host != 'local':
            return result
        # Authorize the exact conversation through the gateway's existing store first.
        bridge.store.get(thread_id)
        try:
            messages = snapshot(bridge.store.home, thread_id)
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
            messages = None
        if messages is not None:
            result['nativeQueue'] = messages
        return result

    view._remoteai_native_queue = True
    bridge_class.view = view
