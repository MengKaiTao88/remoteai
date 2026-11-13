"""Adapt verified desktop state envelopes without changing the native owner or requests."""
from functools import wraps


def compatible_state(message):
    if not isinstance(message, dict) or message.get('method') != 'thread-stream-state-changed':
        return message
    # Codex state v13 retains the v11 snapshot/patch envelope. Unknown versions
    # still reach the pinned bridge's rejection path instead of being guessed.
    if message.get('version') != 13:
        return message
    params = message.get('params')
    change = params.get('change') if isinstance(params, dict) else None
    if not isinstance(change, dict) or type(change.get('revision')) is not int:
        return message
    kind = change.get('type')
    snapshot = kind == 'snapshot' and isinstance(change.get('conversationState'), dict)
    patches = (kind == 'patches' and isinstance(change.get('patches'), list)
               and type(change.get('baseRevision')) is int)
    if not snapshot and not patches:
        return message
    # Identity, owner, revision and permission checks remain with the bridge.
    return {**message, 'version': 11}


def install(bridge=None):
    if bridge is None:
        from bridge.app.service import Bridge
        bridge = Bridge
    original = bridge._event
    if getattr(original, '_remoteai_native_protocol', False):
        return

    @wraps(original)
    def event(self, message):
        return original(self, compatible_state(message))

    event._remoteai_native_protocol = True
    bridge._event = event
