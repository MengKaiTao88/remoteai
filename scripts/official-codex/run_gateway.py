"""Launch the pinned gateway with Remote AI's read-only native-history compatibility."""
import runpy
import sys
from pathlib import Path

from native_history import install
from native_usage import install as install_usage
from native_permissions import install as install_permissions


def main():
    bridge = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(bridge))
    from bridge.features.sessions.store import SessionStore
    from bridge.app.service import Bridge
    from image_archive import install as install_image_archive
    install_usage()
    install_permissions()
    install(SessionStore)
    install_image_archive(Bridge)
    sys.argv = [str(bridge / 'run.py'), *sys.argv[2:]]
    runpy.run_path(str(bridge / 'run.py'), run_name='__main__')


if __name__ == '__main__':
    main()
