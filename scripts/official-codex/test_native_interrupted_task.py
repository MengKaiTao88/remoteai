from threading import Condition, Lock
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from native_interrupted_task import MODE, install


TURN = '019a0000-0000-7000-8000-000000000001'
THREAD = '019a0000-0000-7000-8000-000000000002'


class InterruptedTaskTest(TestCase):
    def setUp(self):
        class Bridge:
            host = 'local'
            send = Mock(return_value={'status': 'ordinary-send'})
            _call = Mock(return_value={})

            def _target(self, thread_id):
                assert thread_id == self.session.id
                return self.session

        self.message_send = Bridge.send
        install(Bridge, lambda state: state['turns'])
        self.bridge = Bridge()
        self.bridge.session = SimpleNamespace(
            id=THREAD, runtime='desktop', origin='desktop', connected=True,
            condition=Condition(), action_lock=Lock(), state={
                'turns': [{'turnId': TURN, 'status': 'interrupted'}], 'threadRuntimeStatus': {'type': 'idle'},
                'latestCollaborationMode': {'mode': 'plan', 'settings': {'model': 'existing-model'}},
            },
        )

    def test_dispatches_an_empty_native_turn_once(self):
        for _ in range(2):
            self.assertEqual(self.bridge.send(THREAD, None, TURN, MODE), {'status': 'accepted', 'resumedFrom': TURN})
        self.bridge._call.assert_called_once_with(self.bridge.session, 'thread-follower-start-turn', {
            'turnStart': {'request': {'threadId': THREAD, 'input': [], 'turnTrigger': 'resume_interrupted_task',
                                     'collaborationMode': self.bridge.session.state['latestCollaborationMode']},
                          'context': {'inheritThreadSettings': True}},
        })
        self.message_send.assert_not_called()

    def test_rejects_active_and_superseded_turns_before_writing(self):
        state = self.bridge.session.state
        state['threadRuntimeStatus']['type'] = 'active'
        with self.assertRaises(ValueError):
            self.bridge.send(THREAD, None, TURN, MODE)
        state['threadRuntimeStatus']['type'] = 'idle'
        state['turns'].append({'turnId': THREAD, 'status': 'interrupted'})
        with self.assertRaises(ValueError):
            self.bridge.send(THREAD, None, TURN, MODE)
        self.bridge._call.assert_not_called()

    def test_keeps_regular_sends_on_the_existing_route(self):
        self.assertEqual(self.bridge.send(THREAD, 'a real draft', TURN).get('status'), 'ordinary-send')
        with self.assertRaises(ValueError):
            self.bridge.send(THREAD, 'a draft', TURN, MODE)
        self.bridge._call.assert_not_called()

    def test_ambiguous_owner_timeout_does_not_repeat_the_action(self):
        self.bridge._call.side_effect = TimeoutError
        with self.assertRaises(TimeoutError):
            self.bridge.send(THREAD, None, TURN, MODE)
        with self.assertRaises(ValueError):
            self.bridge.send(THREAD, None, TURN, MODE)
        self.bridge._call.assert_called_once()
