import unittest
from native_protocol import compatible_state, install


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


if __name__ == '__main__':
    unittest.main()
