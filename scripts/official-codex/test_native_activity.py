import json
import unittest
from types import SimpleNamespace

from native_activity import install_labels, restore_recorded_activity, with_recorded_activities


def event(kind, **fields):
    return {'type': 'event_msg', 'payload': {'type': kind, **fields}}


def response(kind, **fields):
    return {'type': 'response_item', 'payload': {'type': kind, **fields}}


def project(*records):
    raw = '\n'.join(json.dumps(row) for row in records).encode('utf-8') + b'\n'
    return [json.loads(line)['payload'] for line in with_recorded_activities(raw).splitlines() if line]


class NativeActivityTests(unittest.TestCase):
    def test_native_completions_replace_the_wrapper_at_their_recorded_positions(self):
        start = event('task_started', turn_id='turn')
        progress = response('message', role='assistant', phase='commentary')
        wrapper = response('custom_tool_call', call_id='dispatch', name='exec')
        output = response('custom_tool_call_output', call_id='dispatch', output='Details')
        tool = event('item_completed', turn_id='turn', item={
            'id': 'tool', 'type': 'McpToolCall', 'server': 'node_repl', 'tool': 'js',
            'arguments': {'title': 'Find the current tab'}, 'result': {'content': []},
        })
        command = event('item_completed', turn_id='turn', item={
            'id': 'command', 'type': 'CommandExecution', 'command': ['git', 'status'], 'status': 'failed',
            'aggregated_output': 'Sample output', 'exit_code': 1,
        })
        stale = event('item_completed', turn_id='earlier', item={**tool['payload']['item'], 'id': 'stale'})
        payloads = project(start, wrapper, command, progress, stale, tool, tool, output)
        self.assertEqual([row['type'] for row in payloads],
                         ['task_started', 'function_call', 'message', 'item_completed', 'function_call', 'item_completed'])
        cmd, tool = [restore_recorded_activity({**row, 'id': row['call_id']})
                     for row in payloads if row['type'] == 'function_call']
        self.assertEqual((cmd['id'], cmd['type'], cmd['command'], cmd['exitCode']),
                         ('command', 'commandExecution', 'git status', 1))
        self.assertEqual((tool['id'], tool['type'], tool['arguments']['title']),
                         ('tool', 'mcpToolCall', 'Find the current tab'))

    def test_a_raw_wrapper_without_unambiguous_completions_is_retained(self):
        start = event('task_started', turn_id='turn')
        first = response('custom_tool_call', call_id='one', name='exec')
        second = response('custom_tool_call', call_id='two', name='exec')
        tool = event('item_completed', turn_id='turn', item={'id': 'tool', 'type': 'McpToolCall'})
        first_output = response('custom_tool_call_output', call_id='one', output='First')
        second_output = response('custom_tool_call_output', call_id='two', output='Second')
        self.assertEqual([row['call_id'] for row in project(start, first, second, tool, first_output, second_output)[1:]],
                         ['one', 'two', 'tool', 'one', 'two'])

    def test_tool_labels_use_native_title_and_browser_surface(self):
        model = SimpleNamespace(normalize_item=lambda item, **kwargs: {'title': 'node_repl · js', 'output': 'retained'})
        install_labels(model)
        item = {'type': 'mcpToolCall', 'server': 'node_repl', 'arguments': {'title': ' Find\n the tab '},
                'result': {'_meta': {'codex/toolSurface': {'kind': 'browserUse', 'browserFamily': 'chrome'}}}}
        self.assertEqual(model.normalize_item(item), {'title': 'chrome · Find the tab', 'output': 'retained'})
        self.assertEqual(model.normalize_item({**item, 'result': {}})['title'], 'node_repl · Find the tab')
        self.assertEqual(model.normalize_item({**item, 'arguments': []})['title'], 'node_repl · js')


if __name__ == '__main__':
    unittest.main()
