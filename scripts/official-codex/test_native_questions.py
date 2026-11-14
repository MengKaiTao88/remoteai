import copy
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_questions import pending_async_requests, install


def ordered_turns(value):
    history = value.get('turnHistory', {})
    if history.get('kind') != 'canonical':
        return value.get('turns', [])
    history = history['history']
    return [history['entitiesByKey'][entry['value']] for island in history['islands'] for entry in island['entries']]


def text_content(value):
    return value if isinstance(value, str) else '\n'.join(item.get('text', '') for item in value)


def question_replies(text):
    prefix, suffix = '<send_user_message_question_reply>', '</send_user_message_question_reply>'
    if not text.strip().startswith(prefix) or not text.strip().endswith(suffix):
        return []
    return json.loads(text.strip()[len(prefix):-len(suffix)])


model = SimpleNamespace(ordered_turns=ordered_turns, text_content=text_content,
                        items_array=lambda value: list(value.values()) if isinstance(value, dict) else value or [],
                        question_replies=question_replies)


def question(identifier='ask', titles=('Which screen?',)):
    return {'type': 'agentMessage', 'id': identifier, 'delivery': 'async',
            'questions': [{'title': title, 'options': ['A', 'B']} for title in titles]}


def user(text, kind='userMessage', status=None):
    return {'type': kind, 'id': 'reply', 'status': status, 'content': [{'type': 'text', 'text': text}]}


def reply(identifier='ask', index=0, spaced=False):
    key = json.dumps(['request_user_input_async', identifier, index],
                     separators=None if spaced else (',', ':'))
    return '<send_user_message_question_reply>\n' + json.dumps([
        {'questionItemId': key, 'question': 'Which screen?', 'answer': 'A'}]) + '\n</send_user_message_question_reply>'


def state(*items):
    return {'turns': [{'turnId': 'turn', 'status': 'inProgress', 'items': list(items)}], 'requests': []}


class QuestionsTests(unittest.TestCase):
    def pending(self, value):
        before = copy.deepcopy(value)
        result = pending_async_requests(value, model)
        self.assertEqual(value, before)
        return result

    def test_exact_official_answer_resolves_from_another_turn(self):
        value = state(question())
        value['turns'].append({'turnId': 'next', 'status': 'inProgress', 'items': [user(reply())]})
        self.assertEqual(self.pending(value), [])

    def test_spaced_identity_resolves_without_text_matching(self):
        self.assertEqual(self.pending(state(question(), user(reply(spaced=True)))), [])
        self.assertEqual(len(self.pending(state(question(), user(reply('other'))))), 1)

    def test_answer_to_one_card_preserves_another(self):
        pending = self.pending(state(question(), question('other'), user(reply())))
        self.assertEqual([p['id'] for p in pending], ['async:turn:other'])

    def test_partial_group_keeps_only_unanswered_question(self):
        pending = self.pending(state(question(titles=('First?', 'Second?')), user(reply())))
        self.assertEqual([q['question'] for q in pending[0]['params']['questions']], ['Second?'])

    def test_ordinary_user_followup_supersedes_old_card(self):
        self.assertEqual(self.pending(state(question(), user('Move these to the right'))), [])

    def test_accepted_steering_supersedes_but_queued_input_does_not(self):
        self.assertEqual(self.pending(state(question(), user('Continue', 'steeringUserMessage', 'accepted'))), [])
        for status in ('pending', 'queued', 'rejected', None):
            self.assertEqual(len(self.pending(state(question(), user('Continue', 'steeringUserMessage', status)))), 1)

    def test_new_card_after_user_followup_stays_available(self):
        pending = self.pending(state(question(), user('Continue'), question('latest')))
        self.assertEqual([p['id'] for p in pending], ['async:turn:latest'])

    def test_params_input_and_canonical_history_are_respected(self):
        first = {'turnId': 'first', 'status': 'completed', 'items': [question()]}
        next_turn = {'turnId': 'next', 'status': 'completed', 'params': {'input': [{'type': 'text', 'text': 'Continue'}]}, 'items': []}
        value = {'turns': [], 'turnHistory': {'kind': 'canonical', 'history': {
            'entitiesByKey': {'one': first, 'two': next_turn},
            'islands': [{'entries': [{'value': 'one'}, {'value': 'two'}]}]}}}
        self.assertEqual(self.pending(value), [])

    def test_completed_turn_preserves_unanswered_card(self):
        value = state(question()); value['turns'][0]['status'] = 'completed'
        self.assertEqual(len(self.pending(value)), 1)

    def test_installed_projection_and_response_validation_use_same_state(self):
        target = SimpleNamespace(**vars(model), async_requests=lambda value: [])
        service = SimpleNamespace(async_requests=target.async_requests)
        with patch.dict(sys.modules, {'bridge.features.sessions': SimpleNamespace(model=target),
                                      'bridge.app': SimpleNamespace(service=service)}):
            install(); installed = target.async_requests; install()
            self.assertIs(target.async_requests, installed)
            self.assertIs(service.async_requests, installed)
            value = state(question(), user('Continue'))
            value['requests'] = [{'id': 7, 'method': 'item/tool/requestUserInput'}]
            self.assertEqual(target.async_requests(value), [])
            self.assertEqual(value['requests'], [{'id': 7, 'method': 'item/tool/requestUserInput'}])


if __name__ == '__main__':
    unittest.main()
