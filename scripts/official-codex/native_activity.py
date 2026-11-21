"""Keep the activities recorded by Codex when the gateway reads a rollout."""
import json
import os
import shlex
import subprocess
from functools import wraps

RECORDED_ACTIVITY = '_remoteaiRecordedActivity'
TOOL_TYPES = {'McpToolCall': 'mcpToolCall', 'DynamicToolCall': 'dynamicToolCall'}
MAX_TITLE = 160


def _recorded_item(payload, turn_id):
    if not turn_id or payload.get('turn_id') != turn_id:
        return None
    item = payload.get('item')
    if not isinstance(item, dict) or not isinstance(item.get('id'), str):
        return None
    kind = item.get('type')
    if isinstance(kind, str) and kind in TOOL_TYPES:
        return {**item, 'type': TOOL_TYPES[kind]}
    if kind != 'CommandExecution':
        return None
    command = item.get('command')
    if isinstance(command, list) and all(isinstance(part, str) for part in command):
        command = subprocess.list2cmdline(command) if os.name == 'nt' else shlex.join(command)
    return {'id': item['id'], 'type': 'commandExecution', 'status': item.get('status'),
            'command': command if isinstance(command, str) else '',
            'aggregatedOutput': item.get('aggregated_output'), 'exitCode': item.get('exit_code')}


def _track_tool_call(payload, index, pending, lines):
    call_id = payload.get('call_id')
    if not isinstance(call_id, str):
        return
    kind = payload.get('type')
    if kind in ('custom_tool_call', 'function_call'):
        wrapper = kind == 'custom_tool_call' and payload.get('name') == 'exec'
        pending[call_id] = (index, wrapper, False)
    elif kind in ('custom_tool_call_output', 'function_call_output'):
        call = pending.pop(call_id, None)
        if call is not None and call[2]:
            lines[call[0]] = lines[index] = b'\n'


def with_recorded_activities(raw):
    """Carry typed completion records through the pinned gateway's rollout parser."""
    if b'"item_completed"' not in raw:
        return raw
    lines = raw.splitlines(keepends=True)
    turn_id = None
    pending = {}
    seen = set()
    for index, line in enumerate(lines):
        if not any(marker in line for marker in (b'"task_started"', b'"item_completed"', b'"call_id"')):
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        payload = record.get('payload') if isinstance(record, dict) else None
        if not isinstance(payload, dict):
            continue
        if record.get('type') == 'response_item':
            _track_tool_call(payload, index, pending, lines)
        elif record.get('type') == 'event_msg' and payload.get('type') == 'task_started':
            turn_id = payload.get('turn_id')
            pending.clear()
            seen.clear()
        elif record.get('type') == 'event_msg' and payload.get('type') == 'item_completed':
            item = _recorded_item(payload, turn_id)
            if item is None or item['id'] in seen:
                continue
            seen.add(item['id'])
            carrier = {'type': 'function_call', 'call_id': item['id'], RECORDED_ACTIVITY: item}
            lines[index] = (json.dumps({'type': 'response_item', 'payload': carrier}, ensure_ascii=False)
                            + '\n').encode('utf-8')
            if len(pending) == 1:
                call_id, (start, wrapper, _) = next(iter(pending.items()))
                pending[call_id] = (start, wrapper, wrapper)
    return b''.join(lines)


def restore_recorded_activity(item):
    recorded = item.get(RECORDED_ACTIVITY)
    if (item.get('type') == 'function_call' and isinstance(recorded, dict)
            and recorded.get('id') == item.get('id')
            and recorded.get('type') in ('commandExecution', *TOOL_TYPES.values())):
        return recorded
    return item


def _tool_surface(item):
    result = item.get('result')
    meta = result.get('_meta') if isinstance(result, dict) else None
    surface = meta.get('codex/toolSurface') if isinstance(meta, dict) else None
    if isinstance(surface, dict) and surface.get('kind') == 'browserUse':
        return 'chrome' if surface.get('browserFamily') == 'chrome' else 'browser'
    return item.get('server')


def install_labels(model):
    original = model.normalize_item
    if getattr(original, '_remoteai_activity_labels', False):
        return

    @wraps(original)
    def normalize(item, **kwargs):
        row = original(item, **kwargs)
        if item.get('type') != 'mcpToolCall':
            return row
        args = item.get('arguments')
        title = args.get('title') if isinstance(args, dict) else None
        title = ' '.join(title.split()) if isinstance(title, str) else ''
        if title:
            # The installed bridge forwards the gateway's existing “server · tool” display label.
            surface = _tool_surface(item)
            title = title if len(title) <= MAX_TITLE else title[:MAX_TITLE - 1].rstrip() + '…'
            row['title'] = ' · '.join(part for part in (surface, title) if isinstance(part, str) and part)
        return row

    normalize._remoteai_activity_labels = True
    model.normalize_item = normalize
