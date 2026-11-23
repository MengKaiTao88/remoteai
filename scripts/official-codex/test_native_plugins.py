import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from native_plugins import _project_plugins, install

PLUGIN = {'id': 'github@fixture', 'name': 'github', 'installed': True, 'enabled': True,
          'interface': {'displayName': 'GitHub', 'composerIconUrl': 'file://private.png'}}
PATH = 'plugin://github@fixture'


class Rejected(ValueError):
    pass


class PluginTests(unittest.TestCase):
    def setUp(self):
        class Bridge:
            host = 'local'

            def catalog(self, _thread, **options):
                return options['kind']

            def _resolve_skills(self, _session, skills):
                return [{'name': key, 'path': f'/skills/{key}/SKILL.md'} for key in skills]

            def _call(self, _session, method, params):
                return method, params

        self.session = SimpleNamespace(origin='desktop', runtime='desktop')
        self.model = SimpleNamespace(normalize_item=lambda item: {'text': item['content'][0]['text']})
        install(Bridge, self.model, Rejected)
        self.bridge = Bridge()
        self.bridge.session = Mock(return_value=self.session)
        self.plugins = _project_plugins({'marketplaces': [{'plugins': [PLUGIN,
            {**PLUGIN, 'id': 'off@fixture', 'enabled': False}, {**PLUGIN, 'id': 'other@fixture', 'installed': False}]}]})

    def test_catalog_returns_only_enabled_installed_plugins_from_the_authorized_thread(self):
        with patch('native_plugins._installed', return_value=(self.plugins, False)) as installed:
            catalog = self.bridge.catalog('test-chat', kind='remoteai-plugins')
        self.bridge.session.assert_called_once_with('test-chat', attach=False, background=True)
        installed.assert_called_once_with(self.bridge, self.session)
        self.assertEqual([row['id'] for row in catalog['marketplaces'][0]['plugins']], ['github@fixture'])
        self.assertNotIn('composerIconUrl', catalog['marketplaces'][0]['plugins'][0]['interface'])
        self.assertEqual(self.bridge.catalog('test-chat', kind='models'), 'models')

    def test_send_and_steer_forward_verified_references_as_native_mentions(self):
        with patch('native_plugins._installed', return_value=(self.plugins, False)):
            selection = self.bridge._resolve_skills(self.session, ['review', PATH, PATH])
            for invalid in ['plugin://disabled@fixture', 'plugin://../not-a-plugin']:
                with self.assertRaises(Rejected):
                    self.bridge._resolve_skills(self.session, [invalid])
        mention = {'type': 'mention', 'name': 'GitHub', 'path': PATH}
        inputs = lambda: [{'type': 'skill', 'name': row['name'], 'path': row['path']} for row in selection]
        start = {'turnStart': {'request': {'input': inputs()}, 'context': {'inheritThreadSettings': True}}}
        self.bridge._call(self.session, 'thread-follower-start-turn', start)
        self.assertEqual(start['turnStart']['request']['input'], [inputs()[0], mention])
        steer = {'input': inputs(), 'restoreMessage': {'request': {'input': inputs()}}}
        self.bridge._call(self.session, 'thread-follower-steer-turn', steer)
        self.assertEqual(steer['input'], [inputs()[0], mention])
        self.assertEqual(steer['restoreMessage']['request']['input'], steer['input'])

    def test_display_keeps_the_reference_without_its_redundant_text_marker(self):
        marker = f'[GitHub]({PATH})'
        content = [{'type': 'text', 'text': f'Use the repository\n\n{marker}'}]
        item = {'type': 'userMessage', 'content': content}
        self.assertEqual(self.model.normalize_item(item)['text'], content[0]['text'])
        content.append({'type': 'mention', 'name': 'GitHub', 'path': PATH})
        row = self.model.normalize_item(item)
        self.assertEqual(row['text'], 'Use the repository')
        self.assertEqual(row['pluginMentions'], [{'name': 'GitHub', 'path': PATH}])


if __name__ == '__main__':
    unittest.main()
