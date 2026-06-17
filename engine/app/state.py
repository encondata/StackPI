"""Persistent state for the StackPI agent.

State is stored as a single JSON document — by default at
/var/lib/stackpi/state.json. Writes are atomic (tempfile + rename) and
the file is chmod'd to 0600. The shape is intentionally a free-form
dict; the agent layers a known set of keys on top:

    {
      "version": 1,
      "device_uuid": str,
      "hardware_serial": str | None,
      "name": str,
      "status": "pre_registered" | "registered" | "revoked",
      "pairing_token": str | None,
      "pairing_token_expires_at": str | None,
      "link_url": str | None,
      "access_token": str | None,
      "access_token_expires_at": str | None,
      "refresh_token": str | None,
      "refresh_token_expires_at": str | None,
      "config": dict,
      "last_seen_at": str | None,
      "updated_at": str,
    }
"""
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict

STATE_VERSION = 1


def read_state(path: str) -> Dict[str, Any]:
    """Load the state file. Returns {} if missing or unreadable."""
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def write_state(path: str, state: Dict[str, Any]) -> None:
    """Atomically write state to disk with 0600 perms.

    Tempfile is created in the same directory as the target so the
    rename is a same-filesystem operation (atomic on POSIX).
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    state = {"version": STATE_VERSION, **state}

    fd, tmp_path = tempfile.mkstemp(prefix=".state.", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, p)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
