"""Adapt installed plugin references while the native desktop owns the turn."""
import re
from collections import OrderedDict
from functools import wraps
from pathlib import Path
from threading import Lock
from time import monotonic

PLUGIN_PREFIX = 'plugin://'
PLUGIN_PATH = re.compile(r'plugin://[a-zA-Z0-9_.@-]{1,300}\Z')
MAX_SELECTION = 8
MAX_LABEL = 200
MAX_DESCRIPTION = 500
PLUGIN_CACHE_SECONDS = 45
MAX_PLUGIN_SCOPES = 12
DRAFT_CATALOG_ID = '00000000-0000-0000-0000-000000000000'


def _name(value):
    if (isinstance(value, str) and value.strip() and len(value) <= MAX_LABEL
            and not any(ord(char) < 32 or ord(char) == 127 for char in value)):
        return value
    return None


def _project_plugins(raw):
    plugins = {}
    for marketplace in raw['marketplaces']:
        for plugin in marketplace['plugins']:
            if plugin.get('installed') is not True or plugin.get('enabled') is not True:
                continue
            identifier = plugin.get('id')
            name = _name(plugin.get('name'))
            if not name or not isinstance(identifier, str) or not PLUGIN_PATH.fullmatch(PLUGIN_PREFIX + identifier):
                continue
            interface = plugin.get('interface') or {}
            label = _name(interface.get('displayName')) or name
            description = interface.get('shortDescription')
            plugins[identifier] = {
                'id': identifier, 'name': name, 'installed': True, 'enabled': True,
                'interface': {'displayName': label,
                              'shortDescription': description[:MAX_DESCRIPTION] if isinstance(description, str) else None},
            }
    return plugins


def _session_directory(session):
    with session.condition:
        state = session.state or session.history_state or {}
        cwd = state.get('cwd') or session.saved_cwd
    if isinstance(cwd, str) and Path(cwd).is_absolute() and Path(cwd).is_dir():
        return cwd
    return None


def _installed(bridge, cwd):
    from bridge.features.sessions.create import _runtime_operation

    raw = _runtime_operation(bridge.catalog_reader.executable, bridge.codex_home,
                             cwd or str(bridge.codex_home),
                             lambda request: request('plugin/installed', {'cwds': [cwd] if cwd else []}))
    return _project_plugins(raw), bool(raw.get('marketplaceLoadErrors'))


def _desktop(bridge, session):
    return bridge.host == 'local' and session.origin == 'desktop'


class _PluginCatalog:
    def __init__(self):
        self.lock = Lock()
        self.cache = OrderedDict()

    def read(self, bridge, cwd):
        key = (bridge, cwd)
        with self.lock:
            cached = self.cache.get(key)
            if cached and monotonic() - cached[0] < PLUGIN_CACHE_SECONDS:
                self.cache.move_to_end(key)
                return cached[1]
            value = _installed(bridge, cwd)
            if not value[1]:
                self.cache[key] = (monotonic(), value)
                self.cache.move_to_end(key)
                if len(self.cache) > MAX_PLUGIN_SCOPES:
                    self.cache.popitem(last=False)
            return value


def _catalog(bridge, thread_id, cache, *, user_scope):
    # Resolve an authorized local thread before reading installed plugins. Project scope
    # comes from the owner's thread, never from a path supplied by the network client.
    session = bridge.session(thread_id, attach=False, background=True)
    if not _desktop(bridge, session):
        raise ValueError('plugin_catalog_unavailable')
    try:
        plugins, partial = cache.read(bridge, None if user_scope else _session_directory(session))
    except (OSError, RuntimeError, KeyError, TypeError, AttributeError, ValueError):
        plugins, partial = {}, True
    return {'marketplaces': [{'plugins': list(plugins.values())}], 'marketplaceLoadErrors': [True] if partial else []}


def _draft_skill_directory(bridge, project):
    if project == 'local|independent':
        return str(bridge.codex_home)
    if not project.startswith('local|'):
        raise ValueError('skill_catalog_unavailable')
    saved = bridge.directory_projects.get(project)
    if saved is None:
        saved = next((row for row in bridge.hosts.projects() if row['key'] == project), None)
    if not saved or saved['host'] != 'local' or saved.get('type', 'desktop') != 'desktop':
        raise ValueError('skill_catalog_unavailable')
    from bridge.features.sessions.create import project_directory

    return project_directory(saved['cwd'], expected=saved.get('directoryIdentity'))['cwd']


def _skill_catalog(bridge, thread_id, kind, options):
    if bridge.host != 'local':
        raise ValueError('skill_catalog_unavailable')
    if kind == 'remoteai-draft-skills':
        if thread_id != DRAFT_CATALOG_ID:
            raise ValueError('skill_catalog_unavailable')
        cwd = _draft_skill_directory(bridge, options.get('query', ''))
    else:
        session = bridge.session(thread_id, attach=False, background=True)
        if not _desktop(bridge, session):
            raise ValueError('skill_catalog_unavailable')
        cwd = _session_directory(session) or str(bridge.codex_home)
    result = bridge.catalog_reader.get_kind('skills', cwd, offset=options.get('offset', 0),
                                            limit=options.get('limit', 500))
    metadata = ('id', 'name', 'displayName', 'description')
    return {'skills': [{key: row.get(key) for key in metadata} for row in result['skills']],
            'total': result['total'], 'errors': [True] if result.get('errors') else []}


def _resolve_plugins(bridge, session, references, reject):
    if not _desktop(bridge, session) or session.runtime != 'desktop':
        raise reject('plugin_selection_unavailable')
    if any(not PLUGIN_PATH.fullmatch(path) for path in references):
        raise reject('plugin_selection_unavailable')
    try:
        plugins, _ = _installed(bridge, _session_directory(session))
        return [{'id': path, 'path': path, 'name': plugins[path.removeprefix(PLUGIN_PREFIX)]['interface']['displayName']}
                for path in sorted(set(references))]
    except (OSError, RuntimeError, KeyError, TypeError, AttributeError, ValueError):
        raise reject('plugin_selection_unavailable') from None


def _as_mentions(parts):
    # The pinned bridge builds this input from its validated, durable selection list.
    for part in parts:
        if part.get('type') == 'skill' and PLUGIN_PATH.fullmatch(part.get('path') or ''):
            part['type'] = 'mention'


def _display_mentions(item, row):
    kind = item.get('type')
    if kind not in ('userMessage', 'steeringUserMessage'):
        return row
    parts = item.get('input' if kind == 'steeringUserMessage' else 'content')
    if not isinstance(parts, list):
        return row
    mentions = {}
    for part in parts:
        if not isinstance(part, dict) or part.get('type') != 'mention':
            continue
        path, name = part.get('path'), _name(part.get('name'))
        if isinstance(path, str) and PLUGIN_PATH.fullmatch(path) and name:
            mentions[path] = {'path': path, 'name': name}
    if not mentions:
        return row
    row['pluginMentions'] = list(mentions.values())
    markers = {f"[{part['name']}]({part['path']})" for part in mentions.values()}
    lines = row['text'].splitlines(keepends=True)
    if lines and lines[-1].strip() in markers:
        while lines and (not lines[-1].strip() or lines[-1].strip() in markers):
            lines.pop()
        row['text'] = ''.join(lines).rstrip('\r\n')
    return row


def install(bridge_class, model, reject):
    original_catalog = bridge_class.catalog
    if getattr(original_catalog, '_remoteai_plugins', False):
        return
    original_resolve = bridge_class._resolve_skills
    original_call = bridge_class._call
    original_normalize = model.normalize_item
    plugin_catalog = _PluginCatalog()

    @wraps(original_catalog)
    def catalog(bridge, thread_id, refresh=False, kind=None, **options):
        if kind in ('remoteai-plugins', 'remoteai-user-plugins'):
            return _catalog(bridge, thread_id, plugin_catalog, user_scope=kind == 'remoteai-user-plugins')
        if kind in ('remoteai-skills', 'remoteai-draft-skills'):
            return _skill_catalog(bridge, thread_id, kind, options)
        return original_catalog(bridge, thread_id, refresh=refresh, kind=kind, **options)

    @wraps(original_resolve)
    def resolve(bridge, session, skills):
        if not isinstance(skills, list):
            return original_resolve(bridge, session, skills)
        plugins = [item for item in skills if isinstance(item, str) and item.startswith(PLUGIN_PREFIX)]
        if not plugins:
            return original_resolve(bridge, session, skills)
        if len(skills) > MAX_SELECTION:
            raise reject('plugin_selection_unavailable')
        ordinary = original_resolve(bridge, session, [item for item in skills if item not in plugins])
        return ordinary + _resolve_plugins(bridge, session, plugins, reject)

    @wraps(original_call)
    def call(bridge, session, method, params, **options):
        if _desktop(bridge, session) and method == 'thread-follower-start-turn':
            _as_mentions(params.get('turnStart', {}).get('request', {}).get('input', []))
        if _desktop(bridge, session) and method == 'thread-follower-steer-turn':
            _as_mentions(params.get('input', []))
            _as_mentions(params.get('restoreMessage', {}).get('request', {}).get('input', []))
        return original_call(bridge, session, method, params, **options)

    @wraps(original_normalize)
    def normalize(item, **options):
        return _display_mentions(item, original_normalize(item, **options))

    catalog._remoteai_plugins = True
    bridge_class.catalog = catalog
    bridge_class._resolve_skills = resolve
    bridge_class._call = call
    model.normalize_item = normalize
