"""Launch the pinned gateway with Remote AI's read-only native-history compatibility."""
import runpy
import sys
from pathlib import Path

from native_history import install
from native_activity import install_labels
from native_usage import install as install_usage
from native_permissions import install as install_permissions
from native_protocol import install as install_protocol
from native_queue import install as install_queue
from native_questions import install as install_questions
from native_interrupted_task import install as install_task_continuation


def main():
    bridge = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(bridge))
    from bridge.features.sessions import model
    from bridge.features.sessions.store import SessionStore
    from bridge.app.service import Bridge
    from image_archive import install as install_image_archive
    install_usage()
    install_protocol(Bridge)
    install_questions()
    install_queue(Bridge)
    install_permissions()
    install(SessionStore)
    install_labels(model)
    install_image_archive(Bridge)
    install_task_continuation(Bridge, model.ordered_turns)
    sys.argv = [str(bridge / 'run.py'), *sys.argv[2:]]
    runpy.run_path(str(bridge / 'run.py'), run_name='__main__')


if __name__ == '__main__':
    main()
