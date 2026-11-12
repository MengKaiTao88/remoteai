import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from native_usage import install, token_usage, saved_usage


class NativeUsageTests(unittest.TestCase):
    def test_indexed_history_restores_recorded_counters_and_refreshes_after_append(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            path = home / 'rollout.jsonl'
            store = SimpleNamespace(_rollout_in_home=lambda candidate: candidate.is_relative_to(home))
            meta = {'rollout_path': str(path)}
            def event(total, last):
                return json.dumps({'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
                    'total_token_usage': {'total_tokens': total}, 'last_token_usage': {'total_tokens': last},
                    'model_context_window': 475000}}}) + '\n'
            path.write_text(event(3795355, 129919) + '{partial', encoding='utf8')
            usage = saved_usage(store, meta)
            self.assertEqual(usage['total']['totalTokens'], 3795355)
            self.assertEqual(usage['contextTokens'], 129919)
            self.assertEqual(usage['modelContextWindow'], 475000)
            self.assertEqual(saved_usage(store, meta), usage)
            usage['total']['totalTokens'] = 0
            self.assertEqual(saved_usage(store, meta)['total']['totalTokens'], 3795355)
            with path.open('a', encoding='utf8') as stream:
                stream.write('\n' + event(3800000, 0))
            self.assertEqual(saved_usage(store, meta)['contextTokens'], 0)
            self.assertEqual(saved_usage(store, meta)['total']['totalTokens'], 3800000)

    def test_history_does_not_read_outside_authorized_home_or_infer_missing_counters(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rollout.jsonl'
            path.write_text(json.dumps({'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
                'last_token_usage': {'total_tokens': 10}}}}), encoding='utf8')
            store = SimpleNamespace(_rollout_in_home=lambda candidate: False)
            with patch.object(Path, 'open', side_effect=AssertionError('outside file read')):
                self.assertIsNone(saved_usage(store, {'rollout_path': str(path)}))
            store._rollout_in_home = lambda candidate: True
            self.assertIsNone(saved_usage(store, {'rollout_path': str(path)}))
            self.assertIsNone(saved_usage(store, {'rollout_path': str(path / 'missing')}))

    def test_history_scan_is_bounded_and_skips_a_truncated_first_line(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rollout.jsonl'
            event = json.dumps({'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
                'total_token_usage': {'total_tokens': 123}, 'last_token_usage': {'total_tokens': 40}}}})
            path.write_text(event + '\n' + 'x' * 400 + '\n', encoding='utf8')
            store = SimpleNamespace(_rollout_in_home=lambda candidate: True)
            with patch('native_usage.HISTORY_USAGE_BYTES', 256):
                self.assertIsNone(saved_usage(store, {'rollout_path': str(path)}))

    def test_billing_is_distinct_from_context_occupancy(self):
        info = {'total': {'totalTokens': 12_000_000}, 'last': {'totalTokens': 250_000},
                'contextTokens': 260_000, 'modelContextWindow': 475_000, 'private': 'not-exported'}
        self.assertEqual(token_usage({'latestTokenUsageInfo': info}), {
            'total': {'totalTokens': 12_000_000}, 'last': {'totalTokens': 250_000},
            'contextTokens': 260_000, 'modelContextWindow': 475_000})

    def test_unknown_usage_is_not_fabricated_from_the_context_count(self):
        self.assertIsNone(token_usage({'contextUsage': {'usedTokens': 12}}))
        self.assertIsNone(token_usage({'latestTokenUsageInfo': {'last': {'totalTokens': 12}}}))
        for bad in [True, -1, 1.2, float('inf')]:
            self.assertIsNone(token_usage({'latestTokenUsageInfo': {
                'total': {'totalTokens': bad}, 'last': {'totalTokens': 12}}}))

    def test_zero_and_compacted_context_are_preserved(self):
        usage = token_usage({'latestTokenUsageInfo': {'total': {'totalTokens': 900},
                            'last': {'totalTokens': 0}, 'modelContextWindow': None}})
        self.assertEqual(usage['contextTokens'], 0)
        self.assertIsNone(usage['modelContextWindow'])

    def test_live_and_saved_views_share_the_adapter_and_installation_is_idempotent(self):
        service = SimpleNamespace(normalize_state=lambda state, *args, **kwargs: {'id': 'thread'})
        class Session:
            def __init__(self):
                self.state = {'latestTokenUsageInfo': {'total': {'totalTokens': 900},
                              'last': {'totalTokens': 40}, 'modelContextWindow': 1000}}
                self.saved_view = None
            def view(self, **kwargs):
                return service.normalize_state(self.state, **kwargs)
        service.LiveSession = Session
        model = SimpleNamespace()
        install(model, service)
        wrapped = service.normalize_state
        install(model, service)
        self.assertIs(service.normalize_state, wrapped)
        self.assertIs(model.normalize_state, wrapped)
        session = Session()
        current = session.view(item_limit=40)
        self.assertEqual(current['tokenUsage']['total']['totalTokens'], 900)
        session.saved_view = current
        session.state = {}
        self.assertEqual(session.view()['tokenUsage'], current['tokenUsage'])


if __name__ == '__main__':
    unittest.main()
