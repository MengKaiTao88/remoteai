import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from contextlib import closing

from native_history import install, saved_index


class NativeHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        home = Path(self.temp.name)
        class Store:
            def __init__(self):
                self.home = home
                self.meta = {'cwd': '/saved', 'model': 'saved-model', 'reasoning_effort': 'high'}
                self.problem = FileNotFoundError('rollout missing')
            def get(self, thread_id):
                if thread_id != 'allowed':
                    raise KeyError('not accessible')
                return self.meta
            def history(self, thread_id, turn_limit=None, item_limit=None):
                if self.problem:
                    raise self.problem
                return {'id': thread_id, 'turns': [], 'latestModel': 'live-model', 'latestReasoningEffort': 'low'}
        install(Store)
        self.store = Store()
        with closing(sqlite3.connect(home / 'thread_history_1.sqlite')) as db, db:
            db.executescript('''CREATE TABLE thread_history_projection_state(thread_id,next_rollout_byte_offset);
                CREATE TABLE thread_turns(thread_id,turn_id,status,error_json,started_at,first_user_item_id);
                CREATE TABLE thread_items(thread_id,turn_id,rollout_ordinal,item_json);''')
            db.execute('INSERT INTO thread_history_projection_state VALUES(?,?)', ('allowed', 100))
            db.execute('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)', ('allowed','turn','completed',None,123,'user'))
            for index in range(3):
                db.execute('INSERT INTO thread_items VALUES(?,?,?,?)', ('allowed','turn',index,
                    json.dumps({'id': str(index), 'type': 'agentMessage', 'text': str(index)})))

    def test_missing_rollout_reads_retained_index_without_execution_state(self):
        result = saved_index(self.store, 'allowed', self.store.meta, 2)
        self.assertEqual([i['id'] for i in result['turns'][0]['items']], ['1', '2'])
        self.assertFalse(result['turns'][0]['_itemsComplete'])
        self.assertFalse(result['turnsPagination']['hasLoadedOldest'])
        self.assertEqual(result['threadRuntimeStatus'], {'type': 'notLoaded'})
        self.assertEqual(result['requests'], [])
        self.assertEqual(self.store.history('allowed', item_limit=2)['latestReasoningEffort'], 'high')
        self.assertEqual(len(self.store.history('allowed', item_limit=2)['turns'][0]['items']), 3)
        self.assertTrue(self.store.history('allowed', item_limit=3)['turnsPagination']['hasLoadedOldest'])

    def test_inaccessible_and_outside_paths_cannot_use_the_index(self):
        with self.assertRaises(KeyError):
            self.store.history('other')
        self.store.problem = ValueError('outside home')
        with self.assertRaisesRegex(ValueError, 'outside home'):
            self.store.history('allowed')

    def test_corrupt_or_absent_index_preserves_original_missing_history_error(self):
        (self.store.home / 'thread_history_1.sqlite').write_bytes(b'corrupt')
        with self.assertRaises(FileNotFoundError):
            self.store.history('allowed')

    def test_existing_history_keeps_its_actual_model_and_effort(self):
        self.store.problem = None
        result = self.store.history('allowed')
        self.assertEqual(result['latestModel'], 'live-model')
        self.assertEqual(result['latestReasoningEffort'], 'low')


if __name__ == '__main__':
    unittest.main()
