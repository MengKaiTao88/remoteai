"""Keep the pinned gateway compatible with the installed desktop transport."""
import os
import sys
from functools import wraps
from pathlib import PureWindowsPath

WINDOWS_DESKTOP_PIPE = r'\\.\pipe\codex-ipc'


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


def _windows_desktop_pipe_missing(path):
    if path.casefold() != WINDOWS_DESKTOP_PIPE:
        return False
    try:
        return all(name.casefold() != 'codex-ipc' for name in os.listdir('\\\\.\\pipe\\'))
    except OSError:
        return False


def _store_desktop_running():
    from bridge.platforms.windows.discovery_ext import registered_candidates, windows_installations

    inventory = windows_installations()
    running = {PureWindowsPath(row['Path']) for row in inventory.get('processes', []) if row.get('Path')}
    return any(candidate.get('packageFamilyName') and PureWindowsPath(candidate['executable']) in running
               for candidate in registered_candidates('codex', inventory))


def _install_windows_activation(bridge, operation, ipc_error):
    original = bridge.activate

    @operation
    def check_desktop(self, thread_id):
        session = self.session(thread_id, attach=False, background=True)
        if session.origin != 'desktop' or session.connected or self.closed.is_set() or not _store_desktop_running():
            return
        try:
            self.ipc.connect()
        except ipc_error as error:
            if getattr(error.__cause__, 'winerror', None) != 2:
                return
            with session.condition:
                if session.connected:
                    return
                session.error = str(error)
                session.rebuild_recommended = False
                session.changed()
            raise

    @wraps(original)
    def activate(self, thread_id):
        # A system deep link can start a second profile when the Store desktop
        # is already running but has no follower listener.
        if self.host == 'local' and _windows_desktop_pipe_missing(self.ipc.path):
            check_desktop(self, thread_id)
        return original(self, thread_id)

    bridge.activate = activate


def install(bridge=None):
    if bridge is None:
        from bridge.app.service import Bridge
        bridge = Bridge
    original = bridge._event
    if getattr(original, '_remoteai_native_protocol', False):
        return

    if sys.platform == 'win32' and hasattr(bridge, 'activate'):
        from bridge.clients.codex.ipc import IPCError
        from bridge.features.accounts.accounts import operation
        _install_windows_activation(bridge, operation, IPCError)

    @wraps(original)
    def event(self, message):
        return original(self, compatible_state(message))

    event._remoteai_native_protocol = True
    bridge._event = event
