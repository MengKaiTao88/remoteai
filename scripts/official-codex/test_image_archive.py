import hashlib
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from image_archive import ImageArchive, install, paths, retain_indexed_images

PNG = b'\x89PNG\r\n\x1a\n' + b'saved-image'


class ImageArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / ('codex-clipboard-' + str(uuid.uuid4()) + '.png')
        self.source.write_bytes(PNG)
        self.thread = str(uuid.uuid4())
        self.archive = ImageArchive(self.root / 'home', self.root)
        self.identifier = hashlib.sha256(str(self.source.resolve()).encode()).hexdigest()

    def test_saved_image_survives_temp_deletion_in_every_chat(self):
        for thread in (self.thread, str(uuid.uuid4())):
            self.archive.capture(thread, str(self.source))
        self.source.unlink()
        image, variant = self.archive.preview(self.thread, str(self.source), self.identifier)
        self.assertEqual(image['previewBytes'], PNG)
        self.assertEqual(variant, 'archive')

    def test_other_chat_or_unrelated_reference_cannot_read_saved_bytes(self):
        self.archive.capture(self.thread, str(self.source))
        with self.assertRaises(OSError):
            self.archive.preview(str(uuid.uuid4()), str(self.source), self.identifier)
        with self.assertRaises(KeyError):
            self.archive.preview(self.thread, str(self.source), '0' * 64)
        with self.assertRaises(ValueError):
            self.archive.location('../outside', str(self.source))
        outside = self.root / 'other' / self.source.name
        with self.assertRaises(ValueError):
            self.archive.location(self.thread, str(outside))

    def test_capture_rejects_non_images_and_oversized_bytes_without_blocking_history(self):
        self.source.write_bytes(b'not an image')
        self.archive.capture(self.thread, str(self.source))
        self.assertFalse(self.archive.root.exists())
        self.source.write_bytes(PNG)
        with patch('image_archive.MAX_BYTES', 8):
            self.archive.capture(self.thread, str(self.source))
        self.assertFalse(self.archive.root.exists())
        self.source.unlink()
        self.archive.capture(self.thread, str(self.source))

    def test_annotation_captures_new_images_and_preview_rechecks_current_membership(self):
        archive = self.archive
        source = str(self.source)
        item = {'type': 'userMessage', 'content': [{'type': 'localImage', 'path': source}]}
        session = SimpleNamespace(id=self.thread, connected=False, state=None,
                                  history_state={'turns': [{'items': [item]}]}, condition=threading.Condition())

        class Bridge:
            host = 'local'
            store = SimpleNamespace(home=archive.root.parent)

            def session(self, thread_id, attach):
                if thread_id != session.id:
                    raise KeyError('Missing chat')
                return session

            def _annotate_upload_attachments(self, session, rows):
                for row in rows:
                    for attachment in row.get('attachments', []):
                        attachment.pop('path', None)

            def desktop_image_preview(self, thread_id, identifier):
                raise KeyError('Original unavailable')

        install(Bridge)
        install(Bridge)
        with patch('image_archive.start_archive_worker'):
            bridge = Bridge()
        with patch('image_archive.ImageArchive', return_value=archive):
            rows = [{'kind': 'userMessage', 'attachments': [{'type': 'localImage', 'path': source}]}]
            bridge._annotate_upload_attachments(session, rows)
            self.assertNotIn('path', rows[0]['attachments'][0])
            self.source.unlink()
            self.assertEqual(bridge.desktop_image_preview(self.thread, self.identifier)[0]['previewBytes'], PNG)
            session.connected = True
            session.state = {'turns': {'turn': {'items': {'user': item}}}}
            self.assertEqual(bridge.desktop_image_preview(self.thread, self.identifier)[0]['previewBytes'], PNG)
            session.connected = False
            session.history_state = {'turns': []}
            with self.assertRaises(KeyError):
                bridge.desktop_image_preview(self.thread, self.identifier)

    def test_extracts_raw_and_normalized_user_attachments(self):
        attachment = {'type': 'localImage', 'path': str(self.source)}
        self.assertEqual(list(paths([{'type': 'userMessage', 'content': [attachment]},
                                     {'kind': 'userMessage', 'attachments': [attachment]}])),
                         [str(self.source), str(self.source)])

    def test_background_retention_covers_unopened_chats_and_incremental_new_messages(self):
        home = self.archive.root.parent
        home.mkdir()
        from contextlib import closing
        with closing(sqlite3.connect(home / 'thread_history_1.sqlite')) as connection, connection:
            connection.execute('CREATE TABLE thread_items(thread_id,item_json,item_type)')
            item = {'type': 'userMessage', 'content': [{'type': 'localImage', 'path': str(self.source)}]}
            connection.execute('INSERT INTO thread_items VALUES(?,?,?)', (self.thread, json.dumps(item), 'userMessage'))
        with patch('image_archive.ImageArchive', return_value=self.archive):
            cursor = retain_indexed_images(home)
            self.assertEqual(cursor, 1)
            other = str(uuid.uuid4())
            with closing(sqlite3.connect(home / 'thread_history_1.sqlite')) as connection, connection:
                connection.execute('INSERT INTO thread_items VALUES(?,?,?)', (other, json.dumps(item), 'userMessage'))
            self.assertEqual(retain_indexed_images(home, cursor), 2)
        self.source.unlink()
        for thread in (self.thread, other):
            self.assertEqual(self.archive.preview(thread, str(self.source), self.identifier)[0]['previewBytes'], PNG)


if __name__ == '__main__':
    unittest.main()
