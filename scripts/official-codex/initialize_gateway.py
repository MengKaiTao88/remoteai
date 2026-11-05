"""Create a private, password-protected loopback gateway configuration without logging secrets."""
import json
import os
import sys
from pathlib import Path

bridge_root, config_path = map(Path, sys.argv[1:])
sys.path.insert(0, str(bridge_root))
from bridge.features.auth.auth import password_record

config_path.parent.mkdir(parents=True, exist_ok=True)
config = {
    "auth": {
        "mode": "password",
        "username": os.environ["REMOTEAI_CODEX_BRIDGE_USERNAME"],
        **password_record(os.environ["REMOTEAI_CODEX_BRIDGE_PASSWORD"]),
    },
    "origins": [],
    "lan": False,
    "connections": [],
}
config_path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
