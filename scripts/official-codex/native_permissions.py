"""Keep current-turn permissions separate from coherent next-turn settings."""
from functools import wraps


def _mode(values, legacy_reviewer=False):
    if not isinstance(values, dict):
        return None
    keys = ('approvalPolicy', 'approvalsReviewer', 'permissions', 'activePermissionProfile', 'sandboxPolicy')
    if not any(key in values for key in keys):
        return None
    profile = values.get('activePermissionProfile')
    profile_id = profile.get('id') if isinstance(profile, dict) else None
    profile_id = profile_id or values.get('permissions')
    policy = values.get('sandboxPolicy')
    policy_type = policy.get('type') if isinstance(policy, dict) else None
    if profile_id == ':danger-full-access' or not profile_id and policy_type == 'dangerFullAccess':
        return 'full-access' if values.get('approvalPolicy') == 'never' else 'custom'
    if profile_id == ':workspace' or not profile_id and policy_type == 'workspaceWrite':
        if values.get('approvalPolicy') == 'on-request':
            reviewer = values.get('approvalsReviewer')
            return 'auto-review' if reviewer == 'auto_review' or legacy_reviewer and reviewer == 'guardian_subagent' else 'ask'
    return 'custom'


def permission_modes(state, turns=(), legacy_reviewer=False):
    params = turns[-1].get('params') if turns else None
    current = _mode(state.get('currentPermissions'), legacy_reviewer)
    if current is None:
        current = _mode(params, legacy_reviewer)
    upcoming = _mode(state.get('latestThreadSettings'), legacy_reviewer)
    return current, upcoming if upcoming is not None else current or 'custom'


def install(model=None, service=None):
    if model is None:
        from bridge.features.sessions import model
    if service is None:
        from bridge.app import service
    original = service.normalize_state
    if getattr(original, '_remoteai_permissions', False):
        return

    def modes(state, legacy_reviewer=False):
        return permission_modes(state, model.ordered_turns(state), legacy_reviewer)

    model.permission_mode = lambda state, legacy_reviewer=False: modes(state, legacy_reviewer)[1]

    @wraps(original)
    def normalize(state, *args, **kwargs):
        result = original(state, *args, **kwargs)
        current, upcoming = modes(state)
        result['permissionMode'] = upcoming
        if current is not None:
            result['currentPermissionMode'] = current
            if current != upcoming:
                result['permissionUpdate'] = 'nextTurn'
        return result

    normalize._remoteai_permissions = True
    service.normalize_state = model.normalize_state = normalize
