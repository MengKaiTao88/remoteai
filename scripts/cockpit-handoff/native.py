"""Serve a fixed set of local Codex operations over the parent's private stdio pipes."""
import json
import msvcrt
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from ctypes import WinDLL, wintypes
from pathlib import Path
from threading import BoundedSemaphore, Lock
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent))
import native_composer
import native_threads

MAX_LINE = 256 * 1024
WORKERS = 8
OUTPUT = Lock()
PIPE = r'\\.\pipe\codex-ipc'


class Offline(Exception):
    pass


def owner_online():
    kernel = WinDLL('kernel32', use_last_error=True)
    wait = kernel.WaitNamedPipeW
    wait.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
    # WaitNamedPipe observes the listener without opening a follower connection.
    return bool(wait(PIPE, 1))


def enable_adapters(bridge_module, adapters):
    from bridge.features.sessions import model
    from bridge.features.sessions.store import SessionStore
    sys.path.insert(0, str(adapters))
    import native_activity
    import native_history
    import native_permissions
    import native_plugins
    import native_protocol
    import native_questions
    import native_queue

    native_history.install(SessionStore)
    native_activity.install_labels(model)
    native_permissions.install()
    native_protocol.install(bridge_module.Bridge)
    native_threads.install_observer_protocol(bridge_module, native_protocol.compatible_state)
    native_plugins.install(bridge_module.Bridge, model, bridge_module.SubmissionRejected)
    native_questions.install()
    native_queue.install(bridge_module.Bridge)
    navigate_desktop = bridge_module.open_in_desktop

    def navigate_existing(thread_id, host):
        if host != 'local' or not owner_online():
            raise Offline()
        return navigate_desktop(thread_id, host)

    bridge_module.open_in_desktop = navigate_existing


def desktop_thread(bridge, raw_id):
    thread_id = str(UUID(raw_id))
    meta = bridge.store.get(thread_id)
    if meta.get('origin') != 'desktop':
        raise ValueError('Desktop conversation required')
    return thread_id


def native_view(bridge, thread_id, request):
    session = bridge.session(thread_id, background=True)
    if request.get('sequence') == session.sequence:
        return {'sequence': session.sequence, 'connected': session.connected and owner_online()}
    result = bridge.view(thread_id, attach=False, background=True)
    result['connected'] = result.get('connected') is True and owner_online()
    if request.get('composer') is True and not result['connected'] and result.get('permissionMode') == 'custom':
        permission = native_composer.saved_permission(bridge.store, thread_id)
        if permission:
            result['permissionMode'] = permission
    return native_threads.display_view(bridge, result)


def native_send(bridge, thread, request):
    if not owner_online() or not bridge.session(thread, attach=False, background=True).connected:
        raise Offline()
    if request['mode'] == 'steer':
        turns = bridge.view(thread, attach=False)['turns']
        if not any(t['id'] == request.get('turnId') and t['status'] == 'inProgress' for t in turns):
            raise ValueError('Active turn changed')
    return bridge.send(thread, request['text'], str(UUID(request['submissionId'])), request['mode'])


def execute(bridge, request):
    operation = request['operation']
    if operation == 'owner':
        return {'connected': owner_online()}
    if operation == 'list':
        limit = min(101, max(1, int(request.get('limit', 51))))
        offset = min(100_000, max(0, int(request.get('offset', 0))))
        rows = bridge.list(query=request.get('search', '')[:200], limit=limit, offset=offset,
                           archived=request.get('archived') is True, source='desktop', local_only=True)
        return {'rows': [native_threads.display_view(bridge, row) for row in rows],
                'pins': bridge.session_pins.identifiers()}
    if operation == 'projects':
        return native_threads.projects(bridge)
    if operation == 'project':
        return native_threads.project_summary(native_threads.saved_project(bridge, request['cwd']))
    if operation == 'models':
        raw_thread = request.get('threadId')
        thread = None if raw_thread is None else desktop_thread(bridge, raw_thread)
        return native_composer.models(bridge, thread, request.get('refresh') is True)
    if operation == 'start':
        if not owner_online():
            raise Offline()
        thread = desktop_thread(bridge, native_composer.create(bridge, request))
        return native_view(bridge, thread, {})
    thread = desktop_thread(bridge, request['threadId'])
    if operation == 'view':
        return native_view(bridge, thread, request)
    if operation == 'olderHistory':
        native_threads.expand_history(bridge, thread)
        return native_view(bridge, thread, {})
    if operation == 'resume':
        if not owner_online():
            raise Offline()
        return {'connected': bridge.activate(thread).connected}
    if operation == 'send':
        return native_send(bridge, thread, request)
    if operation == 'settings':
        if not owner_online():
            raise Offline()
        native_composer.apply(bridge, thread, request['settings'])
        return native_view(bridge, thread, {})
    if operation == 'rename':
        return bridge.rename(thread, request['name'])
    if operation == 'archive':
        return native_threads.archive(bridge, thread, request['archived'], request['requestId'])
    if operation == 'pin':
        return native_threads.pin(bridge, thread, request['pinned'])
    if operation == 'interrupt':
        turns = native_view(bridge, thread, {}).get('turns', [])
        if not owner_online() or not any(t['id'] == request.get('turnId') and t['status'] == 'inProgress' for t in turns):
            raise Offline()
        return bridge.interrupt(thread)
    if operation == 'respond':
        return bridge.respond(thread, request['requestId'], request['response'])
    raise ValueError('Unsupported operation')


def output(value):
    with OUTPUT:
        print(json.dumps(value, ensure_ascii=True, separators=(',', ':')), flush=True)


def dispatch(bridge, request, capacity, rejected):
    try:
        result = execute(bridge, request)
        output({'id': request['id'], 'data': result})
    except Offline:
        output({'id': request['id'], 'error': 'offline'})
    except (ValueError, KeyError, TypeError, rejected):
        output({'id': request['id'], 'error': 'rejected'})
    except Exception:
        # Native exceptions can contain paths or user data. Return a stable error to the host.
        output({'id': request['id'], 'error': 'unavailable'})
    finally:
        capacity.release()


def serve(bridge, rejected):
    capacity = BoundedSemaphore(WORKERS)
    with ThreadPoolExecutor(WORKERS) as pool:
        try:
            while line := sys.stdin.buffer.readline(MAX_LINE + 1):
                if len(line) > MAX_LINE:
                    break
                request = json.loads(line)
                if capacity.acquire(blocking=False):
                    pool.submit(dispatch, bridge, request, capacity, rejected)
                else:
                    output({'id': request['id'], 'error': 'busy'})
        finally:
            bridge.close()


def main():
    runtime, state = map(Path, sys.argv[1:])
    state.mkdir(parents=True, exist_ok=True)
    with (state / 'owner.lock').open('a+b') as owner:
        owner.seek(0)
        msvcrt.locking(owner.fileno(), msvcrt.LK_NBLCK, 1)
        sys.path.insert(0, str(runtime / 'codex-mobile-bridge'))
        from bridge.app import service
        enable_adapters(service, runtime)
        codex = Path.home() / '.codex'
        # The local follower always uses the current Windows user's default profile.
        os.environ['CODEX_HOME'] = str(codex)
        bridge = service.Bridge(codex, state, ipc_path=PIPE)
        output({'ready': True})
        serve(bridge, service.SubmissionRejected)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('REMOTEAI_HANDOFF_NATIVE_UNAVAILABLE', file=sys.stderr)
        sys.exit(1)
