"""Native catalog, thread creation and composer settings for the local Codex profile."""
import json
from pathlib import Path

from native_threads import saved_project

PERMISSIONS = {'read-only': 'ask', 'workspace-write': 'auto-review', 'danger-full-access': 'full-access'}


def models(bridge, thread_id, refresh):
    if thread_id is not None:
        return bridge.catalog(thread_id, kind='models', refresh=refresh)
    selected = bridge.accounts.current_models(refresh) if bridge.accounts else None
    if selected is not None:
        return selected
    return bridge.catalog_reader.get_kind('models', str(bridge.codex_home), refresh=refresh)


def saved_permission(store, thread_id):
    from native_permissions import _mode

    try:
        path = Path(store.get(thread_id)['rollout_path']).resolve()
        if not store._rollout_in_home(path):
            return None
        raw, _ = store._recent_lines(path, 1)
    except (OSError, KeyError, TypeError, ValueError):
        return None
    for line in reversed(raw.splitlines()):
        if b'"turn_context"' not in line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get('type') == 'turn_context':
            context = event.get('payload')
            if not isinstance(context, dict):
                return None
            sandbox = context.get('sandbox_policy')
            sandbox_type = {'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess'}
            kind = sandbox.get('type') if isinstance(sandbox, dict) else None
            return _mode({'approvalPolicy': context.get('approval_policy'),
                          'approvalsReviewer': context.get('approvals_reviewer'),
                          'activePermissionProfile': context.get('active_permission_profile'),
                          'sandboxPolicy': {'type': sandbox_type.get(kind) if isinstance(kind, str) else None}},
                         legacy_reviewer=True)
    return None


def create(bridge, request):
    project_key = 'local|independent'
    cwd = request.get('cwd')
    if cwd:
        project_key = saved_project(bridge, cwd)['key']
    receipt = bridge.create_chat(project_key, request['title'], request['requestId'], kind='desktop')
    if receipt['host'] != 'local':
        raise ValueError('Local desktop conversation required')
    return receipt['id']


def apply(bridge, thread_id, changes):
    if 'model' in changes:
        result = bridge.settings(thread_id, changes['model'], changes['effort'])
        if not result.get('confirmed'):
            raise ValueError('Model settings were not confirmed')
    if 'access' in changes:
        result = bridge.permissions(thread_id, PERMISSIONS[changes['access']], confirmed=True,
                                    expected_runtime='desktop')
        if not result.get('confirmed'):
            raise ValueError('Permissions were not confirmed')
