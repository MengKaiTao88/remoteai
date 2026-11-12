"""Preserve native billing and context counters at the gateway's display boundary."""
from functools import wraps
from collections import OrderedDict
from pathlib import Path
import json
import threading

HISTORY_USAGE_BYTES = 8 * 1024 * 1024
_history_cache = OrderedDict()
_history_lock = threading.Lock()


def _counter(value):
    return type(value) is int and 0 <= value <= 9_007_199_254_740_991


def token_usage(state):
    info = state.get('latestTokenUsageInfo')
    if not isinstance(info, dict):
        return None
    total, last = info.get('total'), info.get('last')
    if not isinstance(total, dict) or not isinstance(last, dict):
        return None
    total, last = total.get('totalTokens'), last.get('totalTokens')
    if not _counter(total) or not _counter(last):
        return None
    context = info.get('contextTokens')
    window = info.get('modelContextWindow')
    return {'total': {'totalTokens': total}, 'last': {'totalTokens': last},
            'contextTokens': context if _counter(context) else last,
            'modelContextWindow': window if _counter(window) and window > 0 else None}


def saved_usage(store, meta):
    """Read only bounded, authorized rollout counters missing from the item index."""
    try:
        path = Path(meta['rollout_path']).resolve()
        if not store._rollout_in_home(path):
            return None
        before = path.stat()
        key = (str(path), before.st_ino, before.st_size, before.st_mtime_ns)
        with _history_lock:
            if key in _history_cache:
                _history_cache.move_to_end(key)
                cached = _history_cache[key]
                return json.loads(cached) if cached is not None else None
        with path.open('rb') as stream:
            offset = max(0, before.st_size - HISTORY_USAGE_BYTES)
            stream.seek(offset)
            raw = stream.read(HISTORY_USAGE_BYTES)
        after = path.stat()
        if (after.st_ino, after.st_size, after.st_mtime_ns) != key[1:]:
            return None
        lines = raw.splitlines()
        if offset:
            lines = lines[1:]
        usage = None
        for line in reversed(lines):
            if b'token_count' not in line:
                continue
            try:
                record = json.loads(line)
                payload = record.get('payload')
                if record.get('type') != 'event_msg' or not isinstance(payload, dict) or payload.get('type') != 'token_count':
                    continue
                info = payload.get('info')
                if not isinstance(info, dict):
                    continue
                total, last = info.get('total_token_usage'), info.get('last_token_usage')
                if not isinstance(total, dict) or not isinstance(last, dict):
                    continue
                usage = token_usage({'latestTokenUsageInfo': {
                    'total': {'totalTokens': total.get('total_tokens')},
                    'last': {'totalTokens': last.get('total_tokens')},
                    'modelContextWindow': info.get('model_context_window')}})
                if usage is not None:
                    break
            except (ValueError, AttributeError, TypeError):
                continue
        with _history_lock:
            _history_cache[key] = json.dumps(usage) if usage is not None else None
            while len(_history_cache) > 128:
                _history_cache.popitem(last=False)
        return usage
    except (OSError, KeyError, TypeError, ValueError):
        return None


def install(model=None, service=None):
    if model is None:
        from bridge.features.sessions import model
    if service is None:
        from bridge.app import service
    original = service.normalize_state
    if getattr(original, '_remoteai_usage', False):
        return

    @wraps(original)
    def normalize(state, *args, **kwargs):
        result = original(state, *args, **kwargs)
        usage = token_usage(state)
        if usage is not None:
            result['tokenUsage'] = usage
        return result

    normalize._remoteai_usage = True
    service.normalize_state = model.normalize_state = normalize
    original_view = service.LiveSession.view

    @wraps(original_view)
    def view(session, *args, **kwargs):
        result = original_view(session, *args, **kwargs)
        saved = session.saved_view or {}
        if 'tokenUsage' not in result and isinstance(saved.get('tokenUsage'), dict):
            usage = token_usage({'latestTokenUsageInfo': saved['tokenUsage']})
            if usage is not None:
                result['tokenUsage'] = usage
        return result

    service.LiveSession.view = view
