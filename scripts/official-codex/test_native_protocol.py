import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from native_protocol import WINDOWS_DESKTOP_PIPE, _install_windows_activation, compatible_state, install


def message(change, version=13):
    return {'method': 'thread-stream-state-changed', 'version': version,
            'sourceClientId': 'owner', 'params': {'hostId': 'local', 'conversationId': 'thread',
                                               'change': change}}


class ProtocolTests(unittest.TestCase):
    def test_current_snapshot_preserves_identity_state_and_permissions(self):
        state = {'id': 'thread', 'currentPermissions': {'permissions': ':workspace'}}
        source = message({'type': 'snapshot', 'revision': 2, 'conversationState': state})
        result = compatible_state(source)
        self.assertEqual(result['version'], 11)
        self.assertEqual(source['version'], 13)
        self.assertEqual(result['params'], source['params'])
        self.assertEqual(result['sourceClientId'], 'owner')

    def test_current_patches_preserve_base_revision_and_operations(self):
        source = message({'type': 'patches', 'revision': 3, 'baseRevision': 2,
                          'patches': [{'op': 'replace', 'path': '/status', 'value': 'idle'}]})
        result = compatible_state(source)
        self.assertEqual(result['version'], 11)
        self.assertEqual(result['params']['change'], source['params']['change'])

    def test_legacy_unknown_and_malformed_messages_keep_the_existing_validation(self):
        valid = {'type': 'snapshot', 'revision': 1, 'conversationState': {'id': 'thread'}}
        for version in (11, 12, 14):
            source = message(valid, version)
            self.assertIs(compatible_state(source), source)
        for change in ({}, {'type': 'snapshot', 'revision': True, 'conversationState': {}},
                       {'type': 'snapshot', 'revision': 1, 'conversationState': []},
                       {'type': 'patches', 'revision': 1, 'patches': []}):
            source = message(change)
            self.assertIs(compatible_state(source), source)

    def test_install_is_idempotent_and_delegates_without_replaying_operations(self):
        class Bridge:
            def _event(self, value):
                return value['version']
        install(Bridge)
        wrapped = Bridge._event
        install(Bridge)
        self.assertIs(Bridge._event, wrapped)
        self.assertEqual(Bridge()._event(message({'type': 'snapshot', 'revision': 1,
                                                'conversationState': {'id': 'thread'}})), 11)


class GatewayConnectionError(Exception):
    pass


def no_pipe():
    missing = FileNotFoundError()
    missing.winerror = 2
    raise GatewayConnectionError('Desktop connection is unavailable') from missing


class WindowsActivationTests(unittest.TestCase):
    def gateway(self):
        class Bridge:
            def activate(self, thread_id):
                return self.open_desktop(thread_id)

        _install_windows_activation(Bridge, lambda method: method, GatewayConnectionError)
        bridge = Bridge()
        bridge.host = 'local'
        bridge.closed = threading.Event()
        bridge.ipc = SimpleNamespace(path=WINDOWS_DESKTOP_PIPE, connect=Mock(side_effect=no_pipe))
        bridge.session = Mock(return_value=SimpleNamespace(origin='desktop', connected=False,
                                                            condition=threading.Condition(), error=None,
                                                            rebuild_recommended=True, changed=Mock()))
        bridge.open_desktop = Mock(return_value='activated')
        return bridge

    def test_missing_pipe_with_running_store_desktop_blocks_the_launch(self):
        bridge = self.gateway()
        with patch('native_protocol.os.listdir', return_value=['unrelated']), \
             patch('native_protocol._store_desktop_running', return_value=True):
            with self.assertRaises(GatewayConnectionError):
                bridge.activate('thread')
        bridge.open_desktop.assert_not_called()
        chat = bridge.session.return_value
        self.assertEqual(chat.error, 'Desktop connection is unavailable')
        self.assertFalse(chat.rebuild_recommended)
        chat.changed.assert_called_once()

    def test_recovered_pipe_still_uses_the_normal_activation(self):
        bridge = self.gateway()
        bridge.ipc.connect.side_effect = None
        with patch('native_protocol.os.listdir', return_value=[]), \
             patch('native_protocol._store_desktop_running', return_value=True):
            self.assertEqual(bridge.activate('thread'), 'activated')
        bridge.open_desktop.assert_called_once_with('thread')

    def test_other_activation_paths_keep_the_existing_behavior(self):
        for host, origin, pipe, process_running, pipes in (
            ('local', 'desktop', WINDOWS_DESKTOP_PIPE, False, []),
            ('local', 'desktop', WINDOWS_DESKTOP_PIPE, True, ['CODEX-IPC']),
            ('local', 'cli', WINDOWS_DESKTOP_PIPE, True, []),
            ('remote:test', 'desktop', WINDOWS_DESKTOP_PIPE, True, []),
            ('local', 'desktop', r'\\.\pipe\another-endpoint', True, []),
        ):
            with self.subTest(host=host, origin=origin, pipe=pipe, desktop=process_running, pipes=pipes):
                bridge = self.gateway()
                bridge.host = host
                bridge.ipc.path = pipe
                bridge.session.return_value.origin = origin
                with patch('native_protocol.os.listdir', return_value=pipes), \
                     patch('native_protocol._store_desktop_running', return_value=process_running):
                    self.assertEqual(bridge.activate('thread'), 'activated')
                bridge.ipc.connect.assert_not_called()
                bridge.open_desktop.assert_called_once_with('thread')


if __name__ == '__main__':
    unittest.main()
