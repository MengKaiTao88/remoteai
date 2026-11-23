"""Continue the desktop owner's interrupted turn through its empty-input action."""
from copy import deepcopy
from functools import wraps
from uuid import UUID


MODE = 'resume-interrupted-task'


def _resume(bridge, ordered_turns, thread_id, expected_turn_id):
    if not isinstance(expected_turn_id, str) or str(UUID(expected_turn_id)) != expected_turn_id:
        raise ValueError('Invalid interrupted turn')
    session = bridge._target(thread_id)
    if bridge.host != 'local' or session.runtime != 'desktop' or session.origin != 'desktop':
        raise ValueError('Desktop task continuation is unavailable')

    accepted = {'status': 'accepted', 'resumedFrom': expected_turn_id}
    with session.action_lock:
        with session.condition:
            state = session.state or {}
            latest = next((turn for turn in reversed(ordered_turns(state)) if turn.get('turnId')), {})
            previous = getattr(session, '_remoteai_task_continuation', None)
            if previous == (expected_turn_id, True):
                return accepted
            if (not session.connected or latest.get('turnId') != expected_turn_id
                    or latest.get('status') != 'interrupted' or state.get('threadRuntimeStatus', {}).get('type') == 'active'):
                raise ValueError('The interrupted turn is no longer current')
            if previous == (expected_turn_id, False):
                raise ValueError('The owner has not confirmed this continuation')
            collaboration = deepcopy(state.get('latestCollaborationMode'))
            # The IPC response can time out after the owner has already received the action.
            session._remoteai_task_continuation = (expected_turn_id, False)
        request = {'threadId': session.id, 'input': [], 'turnTrigger': 'resume_interrupted_task'}
        if isinstance(collaboration, dict):
            request['collaborationMode'] = collaboration
        bridge._call(session, 'thread-follower-start-turn', {
            'turnStart': {'request': request, 'context': {'inheritThreadSettings': True}},
        })
        session._remoteai_task_continuation = (expected_turn_id, True)
        return accepted


def install(bridge_class, ordered_turns):
    original_send = bridge_class.send
    if getattr(original_send, '_remoteai_task_continuation', False) is True:
        return

    @wraps(original_send)
    def send(self, thread_id, text, submission_id, mode='send', skills=None, **settings):
        if mode != MODE:
            return original_send(self, thread_id, text, submission_id, mode, skills, **settings)
        # The pinned HTTP router already authenticates this write envelope.
        if text is not None or skills or any(value not in (None, []) for value in settings.values()):
            raise ValueError('Task continuation cannot carry message contents or settings')
        return _resume(self, ordered_turns, thread_id, submission_id)

    send._remoteai_task_continuation = True
    bridge_class.send = send
