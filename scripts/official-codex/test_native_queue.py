import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from native_queue import install, snapshot

THREAD = '00000000-0000-4000-8000-000000000001'
OTHER = '00000000-0000-4000-8000-000000000002'


class NativeQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.db = sqlite3.connect(self.home / 'queue_1.sqlite')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE queued_items(id TEXT, thread_id TEXT, payload_json TEXT, '
                        'queue_order INTEGER, created_at_ms INTEGER)')

    def insert(self, identifier, text, order=0, thread=THREAD):
        self.db.execute('INSERT INTO queued_items VALUES(?,?,?,?,?)',
                        (identifier, thread, json.dumps({'input': [{'type': 'text', 'text': text}]}), order, 1))
        self.db.commit()

    def test_exact_thread_order_and_read_only_projection(self):
        self.insert('second', 'same text', 2)
        self.insert('first', 'same text', 1)
        self.insert('private-other-chat', 'other', thread=OTHER)
        before = list(self.db.execute('SELECT * FROM queued_items'))
        result = snapshot(self.home, THREAD)
        self.assertEqual([item['id'] for item in result], ['first', 'second'])
        self.assertEqual(list(self.db.execute('SELECT * FROM queued_items')), before)

    def test_empty_queue_is_an_authoritative_empty_array(self):
        self.assertEqual(snapshot(self.home, THREAD), [])
        self.insert('first', 'hello')
        self.assertEqual(len(snapshot(self.home, THREAD)), 1)
        self.db.execute('DELETE FROM queued_items')
        self.db.commit()
        self.assertEqual(snapshot(self.home, THREAD), [])

    def test_unknown_payload_does_not_fabricate_an_empty_queue(self):
        self.db.execute('INSERT INTO queued_items VALUES(?,?,?,?,?)', ('bad', THREAD, '{}', 0, 1))
        self.db.commit()
        with self.assertRaises(ValueError):
            snapshot(self.home, THREAD)

    def test_missing_database_is_not_created(self):
        missing = self.home / 'missing'
        self.assertIsNone(snapshot(missing, THREAD))
        self.assertFalse(missing.exists())

    def test_invalid_thread_is_rejected(self):
        with self.assertRaises(ValueError):
            snapshot(self.home, '../private')

    def test_live_desktop_queue_format_is_read_without_context_or_credentials(self):
        item = {'id': 'desktop-message', 'text': 'queue synchronization test', 'createdAt': 42,
                'context': {'imageAttachments': [], 'additionalContext': {'private': 'do not expose'}},
                'submissionOptions': {'executionHostId': 'local', 'permissionProfileId': 'private'}}
        state = self.home / '.codex-global-state.json'
        state.write_text(json.dumps({'unrelated-private-data': 'secret', 'queued-follow-ups': {
            THREAD: [item], OTHER: [{**item, 'id': 'other-chat'}]}}))
        result = snapshot(self.home, THREAD)
        self.assertEqual(result, [{'id': 'desktop-message', 'text': 'queue synchronization test',
                                  'imageCount': 0, 'createdAt': 42}])
        self.assertNotIn('secret', json.dumps(result))
        self.assertEqual(json.loads(state.read_text())['queued-follow-ups'][THREAD], [item])

    def test_desktop_queue_and_server_queue_deduplicate_only_exact_identity(self):
        self.insert('same-id', 'same text')
        (self.home / '.codex-global-state.json').write_text(json.dumps({'queued-follow-ups': {
            THREAD: [{'id': 'same-id', 'text': 'same text'}, {'id': 'different-id', 'text': 'same text'}]}}))
        self.assertEqual([item['id'] for item in snapshot(self.home, THREAD)], ['same-id', 'different-id'])

    def test_gateway_authorizes_before_reading_and_never_reads_remote_home(self):
        class Bridge:
            host = 'local'
            def view(self, thread, *args, **kwargs):
                return {'id': thread}
        install(Bridge)
        installed = Bridge.view
        install(Bridge)
        self.assertIs(Bridge.view, installed)
        bridge = Bridge()
        def deny(thread):
            raise PermissionError('unavailable')
        bridge.store = SimpleNamespace(home=self.home, get=deny)
        with self.assertRaises(PermissionError):
            bridge.view(THREAD)
        bridge.host = 'remote'
        self.assertNotIn('nativeQueue', bridge.view(THREAD))


if __name__ == '__main__':
    unittest.main()
