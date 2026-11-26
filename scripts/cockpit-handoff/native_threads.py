"""Local Codex project selection and conversation organization."""
from pathlib import Path

HISTORY_ITEM_STEP = 40
HISTORY_TURN_STEP = 5


def install_observer_protocol(service, compatible_state):
    class CompatibleDesktopIPC(service.DesktopIPC):
        def __init__(self, path, on_event=None, on_disconnect=None):
            def event(message):
                on_event(compatible_state(message))

            super().__init__(path, on_event=event if on_event else None, on_disconnect=on_disconnect)

    # The pinned bridge creates a separate observer for archive's live idle check.
    service.DesktopIPC = CompatibleDesktopIPC


def project_summary(project):
    return {'cwd': project['cwd'], 'label': project['name']}


def projects(bridge):
    return [project_summary(row) for row in bridge.hosts.projects() if row['host'] == 'local']


def saved_project(bridge, cwd):
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        raise ValueError('Invalid project')
    project = bridge._saved_desktop_project(cwd)
    if project is None:
        raise ValueError('Project must be saved in Codex')
    return project


def pin(bridge, thread_id, pinned):
    bridge.pin(thread_id, pinned)
    return bridge.session_pins.identifiers()


def archive(bridge, thread_id, archived, request_id):
    from bridge.features.sessions.create import ArchiveRejected

    try:
        return bridge.archive(thread_id, archived, request_id)
    except ArchiveRejected as error:
        # ArchiveRejected exposes a curated message and keeps the raw RPC error separate.
        return {'status': 'rejected', 'reason': str(error)}


def display_view(bridge, view):
    cwd = view.get('cwd')
    if cwd and Path(cwd).parent == bridge.data_dir / 'independent-chats':
        return {**view, 'cwd': ''}
    return view


def expand_history(bridge, thread_id):
    session = bridge.session(thread_id, attach=False, background=True)
    with session.condition:
        if session.saved_view and session.saved_view.get('historyComplete') is True:
            return
        session.timeline_limit += HISTORY_ITEM_STEP
        session.history_limit += HISTORY_TURN_STEP
        item_limit = session.timeline_limit
    saved = bridge._saved_history(session)
    with session.condition:
        if session.timeline_limit == item_limit:
            session.set_history(saved)
