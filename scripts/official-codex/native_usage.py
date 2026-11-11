"""Preserve native billing and context counters at the gateway's display boundary."""
from functools import wraps


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
