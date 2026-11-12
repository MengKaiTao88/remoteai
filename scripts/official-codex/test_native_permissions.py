import unittest
from types import SimpleNamespace
from native_permissions import install, permission_modes


class NativePermissionTests(unittest.TestCase):
    def state(self):
        full = {'approvalPolicy': 'never', 'approvalsReviewer': 'user',
                'activePermissionProfile': {'id': ':danger-full-access'},
                'sandboxPolicy': {'type': 'dangerFullAccess'}}
        upcoming = {'approvalPolicy': 'on-request', 'approvalsReviewer': 'auto_review',
                    'activePermissionProfile': {'id': ':workspace'},
                    'sandboxPolicy': {'type': 'workspaceWrite'}}
        return {'currentPermissions': full, 'latestThreadSettings': upcoming}, [
            {'params': {**full, 'permissions': ':danger-full-access'}}]

    def test_old_turn_alias_does_not_override_the_new_profile(self):
        state, turns = self.state()
        self.assertEqual(permission_modes(state, turns), ('full-access', 'auto-review'))
        state['latestThreadSettings']['approvalsReviewer'] = 'user'
        self.assertEqual(permission_modes(state, turns), ('full-access', 'ask'))

    def test_transition_and_canonical_snapshot_resolve_to_the_same_upcoming_mode(self):
        state, turns = self.state()
        state['latestThreadSettings']['permissions'] = ':workspace'
        state['latestThreadSettings']['sandboxPolicy'] = {'type': 'dangerFullAccess'}
        self.assertEqual(permission_modes(state, turns)[1], 'auto-review')
        del state['latestThreadSettings']['permissions']
        state['latestThreadSettings']['sandboxPolicy'] = {'type': 'workspaceWrite'}
        self.assertEqual(permission_modes(state, turns)[1], 'auto-review')

    def test_model_only_settings_keep_current_permissions_and_custom_is_not_guessed(self):
        state, turns = self.state()
        state['latestThreadSettings'] = {'model': 'model', 'effort': 'high'}
        self.assertEqual(permission_modes(state, turns), ('full-access', 'full-access'))
        state['latestThreadSettings'] = {'activePermissionProfile': {'id': 'custom-policy'}}
        self.assertEqual(permission_modes(state, turns)[1], 'custom')
        self.assertEqual(permission_modes({}, []), (None, 'custom'))

    def test_adapter_reports_pending_timing_without_changing_native_permissions(self):
        state, turns = self.state()
        model = SimpleNamespace(ordered_turns=lambda state: turns)
        service = SimpleNamespace(normalize_state=lambda state: {'id': 'thread'})
        install(model, service)
        normalized = service.normalize_state(state)
        self.assertEqual(normalized['permissionMode'], 'auto-review')
        self.assertEqual(normalized['currentPermissionMode'], 'full-access')
        self.assertEqual(normalized['permissionUpdate'], 'nextTurn')
        self.assertEqual(state['currentPermissions']['approvalPolicy'], 'never')
        original = service.normalize_state
        install(model, service)
        self.assertIs(service.normalize_state, original)


if __name__ == '__main__':
    unittest.main()
