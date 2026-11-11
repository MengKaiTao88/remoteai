import unittest
from types import SimpleNamespace
from native_usage import install, token_usage


class NativeUsageTests(unittest.TestCase):
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
