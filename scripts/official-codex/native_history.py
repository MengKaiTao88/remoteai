"""Read saved native history without activating Desktop or changing its databases."""
import json
import sqlite3
from contextlib import closing
from pathlib import Path
from image_archive import capture_history
from native_activity import restore_recorded_activity, with_recorded_activities
from native_usage import saved_usage, token_usage

DEFAULT_ITEMS = 5_000
MAX_ITEMS = 50_000
PROJECT_INSTRUCTIONS_KIND = 'agents_md.instructions'
CONTEXT_ONLY_PART = {'type': 'remoteai_context_only'}


def without_project_context(raw):
    """Use the native content kinds to distinguish injected context from actual chat input."""
    if b'"agents_md.instructions"' not in raw:
        return raw
    lines = raw.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if b'"agents_md.instructions"' not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        payload = record.get('payload') or {}
        if (record.get('type') != 'response_item' or payload.get('type') != 'message'
                or payload.get('role') != 'user'):
            continue
        metadata = payload.get('internal_chat_message_metadata_passthrough') or {}
        kinds = metadata.get('content_item_kinds') if isinstance(metadata, dict) else None
        content = payload.get('content')
        if not isinstance(kinds, list) or not isinstance(content, list) or len(kinds) != len(content):
            continue
        parts = [part for part, kind in zip(content, kinds) if kind != PROJECT_INSTRUCTIONS_KIND]
        if len(parts) != len(content):
            # Keep the fallback parser's synthetic ordinal for every subsequent item.
            payload['content'] = parts or [CONTEXT_ONLY_PART]
            lines[index] = (json.dumps(record, ensure_ascii=False) + '\n').encode('utf-8')
    return b''.join(lines)


def _open_index(home):
    database = Path(home) / 'thread_history_1.sqlite'
    with database.open('rb') as stream:
        wal = stream.read(20)[18:20] == b'\x02\x02'
    if wal and not all(Path(str(database) + suffix).is_file() for suffix in ('-wal', '-shm')):
        raise FileNotFoundError('Native history sidecars are unavailable')
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=.2)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
    except Exception:
        connection.close()
        raise
    return connection


def _turn(connection, thread_id, turn_id, complete):
    row = connection.execute('SELECT * FROM thread_turns WHERE thread_id=? AND turn_id=?',
                             (thread_id, turn_id)).fetchone()
    if row is None:
        raise ValueError('Native history turn is unavailable')
    return {'turnId': turn_id, 'status': row['status'], 'turnStartedAtMs': row['started_at'],
            '_firstUserItemId': row['first_user_item_id'], '_itemsComplete': complete,
            'error': json.loads(row['error_json']) if row['error_json'] else None, 'items': []}


def saved_index(store, thread_id, meta, item_limit):
    """The verified store metadata authorizes this ID; the index is display-only."""
    limit = max(1, min(int(item_limit or DEFAULT_ITEMS), MAX_ITEMS))
    with closing(_open_index(store.home)) as connection:
        projection = connection.execute('SELECT next_rollout_byte_offset FROM thread_history_projection_state '
                                        'WHERE thread_id=?', (thread_id,)).fetchone()
        if projection is None or projection[0] <= 0:
            raise ValueError('Native history projection is unavailable')
        rows = connection.execute('SELECT turn_id, item_json FROM thread_items WHERE thread_id=? '
                                  'ORDER BY rollout_ordinal DESC LIMIT ?', (thread_id, limit + 1)).fetchall()
        if not rows:
            raise ValueError('Native history items are unavailable')
        more = len(rows) > limit
        turns = {}
        for row in reversed(rows[:limit]):
            turn_id = row['turn_id']
            if turn_id not in turns:
                turns[turn_id] = _turn(connection, thread_id, turn_id,
                                       not (more and turn_id == rows[limit]['turn_id']))
            item = json.loads(row['item_json'])
            if not isinstance(item, dict) or not isinstance(item.get('type'), str):
                raise ValueError('Native history item is invalid')
            turns[turn_id]['items'].append(item)
    return {'id': thread_id, 'title': meta.get('name') or meta.get('title'), 'cwd': meta['cwd'],
            'modelProvider': meta.get('model_provider'), 'turns': list(turns.values()),
            'turnsPagination': {'hasLoadedOldest': not more}, 'requests': [],
            'threadRuntimeStatus': {'type': 'notLoaded'}, 'historyReadSource': 'native-index-retained'}


def install(store_class):
    """Extend the pinned gateway at startup; its vendored source stays unchanged."""
    if getattr(store_class.history, '_remoteai_retained_history', False):
        return
    original = store_class.history
    original_recent_lines = getattr(store_class, '_recent_lines', None)
    if original_recent_lines is not None:
        def recent_lines(path, turn_limit):
            raw, complete = original_recent_lines(path, turn_limit)
            return with_recorded_activities(without_project_context(raw)), complete

        store_class._recent_lines = staticmethod(recent_lines)

    def history(store, thread_id, turn_limit=None, item_limit=None):
        meta = store.get(thread_id)
        try:
            result = original(store, thread_id, turn_limit=turn_limit, item_limit=item_limit)
        except FileNotFoundError as missing:
            # The original reader already verified rollout containment before stat failed.
            # Never treat a corrupt/outside path or arbitrary SQLite error as authorization.
            try:
                # The existing snapshot adapter pages locally; retain enough indexed
                # history to let its earlier-message cursor reach the saved beginning.
                result = saved_index(store, thread_id, meta, max(DEFAULT_ITEMS, item_limit or 0))
            except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
                raise missing
        if not result.get('latestModel'):
            result['latestModel'] = meta.get('model')
        if not result.get('latestReasoningEffort'):
            result['latestReasoningEffort'] = meta.get('reasoning_effort')
        if token_usage(result) is None:
            usage = saved_usage(store, meta)
            if usage is not None:
                result['latestTokenUsageInfo'] = usage
                result['tokenUsageFromHistory'] = True
        for turn in result.get('turns', []):
            turn['items'] = [restore_recorded_activity(item) for item in turn.get('items', [])
                             if item.get('content') != [CONTEXT_ONLY_PART]]
        capture_history(store.home, thread_id, result)
        return result

    history._remoteai_retained_history = True
    store_class.history = history
