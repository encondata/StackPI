#!/usr/bin/env python3
"""StackPI status-display receiver.

Runs on a remote display Pi. Listens for the primary's status snapshot on UDP
multicast and serves it back to a local kiosk browser by EMULATING the handful
of /local/* endpoints (and SSE streams) that the reused portal /status + /trucks
pages call — so those pages run unchanged, just pointed at this localhost server.

Also serves a tiny on-device setup page at /setup (Wi-Fi + multicast/screen
config) so the display can be configured without SSH.

stdlib only (no pip): socket + http.server + threading + nmcli. Config in
/etc/stackpi-display/config.json (csg-writable; see config.example.json).
See status-protocol.md for the snapshot schema.
"""
import json
import logging
import os
import re
import socket
import struct
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, parse_qs

log = logging.getLogger("stackpi.display.receiver")

CONFIG_PATH = os.environ.get("STACKPI_DISPLAY_CONFIG", "/etc/stackpi-display/config.json")
SETUP_HTML = os.environ.get("STACKPI_DISPLAY_SETUP", "/opt/stackpi-display/setup.html")
DEFAULTS = {
    "multicast_group": "239.10.10.11",
    "multicast_port": 5006,
    "http_port": 8080,
    "web_dir": "/opt/stackpi-display/web",
    "screen": "status",
    "repo_dir": "/home/csg/StackPI_v2",
}

# Live config (group/port can change at runtime via /api/config).
CONFIG: Dict[str, Any] = dict(DEFAULTS)
_cfg_lock = threading.Lock()
_listen_sock: Optional[socket.socket] = None  # closed to force a rejoin


def load_config() -> None:
    with _cfg_lock:
        CONFIG.clear()
        CONFIG.update(DEFAULTS)
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                CONFIG.update(json.load(fh))
        except (OSError, ValueError) as e:
            log.warning("config %s not loaded (%s); using defaults", CONFIG_PATH, e)


def cfg(key: str) -> Any:
    with _cfg_lock:
        return CONFIG.get(key, DEFAULTS.get(key))


def save_config(updates: Dict[str, Any]) -> None:
    """Merge updates into the config file and re-join multicast if the
    group/port changed (no process restart)."""
    with _cfg_lock:
        CONFIG.update(updates)
        snapshot = dict(CONFIG)
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh, indent=2)
    # Force the listener to rebind with the new group/port.
    global _listen_sock
    if _listen_sock is not None:
        try:
            _listen_sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Latest-snapshot store
# ---------------------------------------------------------------------------

class SnapshotStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snap: Dict[str, Any] = {}

    def set(self, snap: Dict[str, Any]) -> None:
        with self._lock:
            self._snap = snap

    def get(self) -> Dict[str, Any]:
        with self._lock:
            return self._snap


STORE = SnapshotStore()


def multicast_listener() -> None:
    """Join the configured multicast group and feed status datagrams into STORE.
    Rebinds when the config changes (save_config closes the socket) or on error."""
    global _listen_sock
    while True:
        group, port = cfg("multicast_group"), int(cfg("multicast_port"))
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("", port))
            mreq = struct.pack("4sl", socket.inet_aton(group), socket.INADDR_ANY)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            _listen_sock = sock
            log.info("listening for status snapshots on %s:%s", group, port)
            while True:
                data, _addr = sock.recvfrom(65535)
                try:
                    msg = json.loads(data.decode("utf-8"))
                except ValueError:
                    continue
                if isinstance(msg, dict) and msg.get("type") == "status":
                    STORE.set(msg)
        except OSError as e:
            # save_config closed the socket → rebind with new group/port.
            log.info("multicast listener rebinding (%s)", e)
            time.sleep(1)


# ---------------------------------------------------------------------------
# Snapshot → emulated /local/* endpoint responses
# ---------------------------------------------------------------------------

def _readers_from_snapshot(snap: Dict[str, Any]) -> Dict[str, Any]:
    r = snap.get("reader") or {}
    state = r.get("state")
    if not r.get("name"):
        return {"readers": []}
    last_status: Optional[Dict[str, Any]] = None
    last_error: Optional[str] = None
    if state == "offline":
        last_error = "reader offline"
    elif state == "reading":
        last_status = {"radioActivity": "active", "interfaceConnectionStatus": {"data": [{"connectionStatus": "connected"}]}}
    elif state in ("online", "degraded"):
        last_status = {"radioActivity": "inactive", "interfaceConnectionStatus": {"data": [{"connectionStatus": "connected" if state == "online" else "disconnected"}]}}
    return {
        "readers": [
            {"id": 1, "name": r.get("name"), "enabled": True,
             "last_error": last_error, "last_status": last_status,
             "last_status_at": snap.get("ts")}
        ]
    }


def emulate(path: str) -> Optional[Any]:
    snap = STORE.get()
    if path == "/local/metrics":
        return snap.get("metrics") or {}
    if path == "/local/status":
        reg = snap.get("registration") or {}
        return {"registration": reg, "status": reg.get("status", "unknown")}
    if path == "/local/rfid/readers":
        return _readers_from_snapshot(snap)
    if path in ("/local/settings", "/local/rfid/settings", "/local/settings/screen-status"):
        return {}
    return None


SSE_PATHS = {
    "/local/system-events/stream": "events",
    "/local/rfid/matches/stream": "activity",
    "/local/rfid/scans/stream": "activity",
}


# ---------------------------------------------------------------------------
# nmcli helpers (Wi-Fi setup)
# ---------------------------------------------------------------------------

def _nmcli(args: List[str], timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(["nmcli", *args], capture_output=True, text=True, timeout=timeout)


def wifi_scan() -> List[dict]:
    try:
        p = _nmcli(["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto"])
    except (subprocess.SubprocessError, OSError):
        return []
    seen, out = set(), []
    for line in p.stdout.splitlines():
        parts = line.split(":")
        if len(parts) < 4:
            continue
        ssid = parts[1].strip()
        if not ssid or ssid in seen:
            continue
        seen.add(ssid)
        out.append({"in_use": parts[0] == "*", "ssid": ssid, "signal": parts[2], "security": parts[3]})
    return out


def wifi_connect(ssid: str, password: str) -> Dict[str, Any]:
    args = ["device", "wifi", "connect", ssid]
    if password:
        args += ["password", password]
    try:
        p = _nmcli(args, timeout=45)
    except (subprocess.SubprocessError, OSError):
        return {"ok": False, "status": "error"}
    # Map the result to a status — never echo raw nmcli output back to the
    # caller (it can contain the SSID/password and other internals).
    return {"ok": p.returncode == 0, "status": "connected" if p.returncode == 0 else "failed"}


def net_status() -> Dict[str, Any]:
    try:
        p = _nmcli(["-t", "-f", "TYPE,STATE,CONNECTION", "device", "status"])
        ip = _nmcli(["-t", "-f", "IP4.ADDRESS", "device", "show"])
    except (subprocess.SubprocessError, OSError):
        return {}
    devices = [dict(zip(("type", "state", "connection"), ln.split(":")[:3]))
               for ln in p.stdout.splitlines() if ln]
    addrs = [ln.split(":", 1)[1] for ln in ip.stdout.splitlines() if ln.startswith("IP4.ADDRESS")]
    return {"devices": devices, "addresses": addrs}


# ---------------------------------------------------------------------------
# Software update (mirrors the primary's /local/update + stackpi-update.sh)
# ---------------------------------------------------------------------------
#
# The display updater re-runs the slim install (git pull → rebuild the export →
# reinstall → restart the services). The heavy lifting is in the privileged
# /usr/local/sbin/stackpi-display-update.sh (root via a scoped NOPASSWD sudoers
# entry); these helpers list git revisions, kick it off, and report progress by
# reading the state/log files it writes to /run/stackpi-display.

UPDATER = "/usr/local/sbin/stackpi-display-update.sh"
UPDATE_UNIT = "stackpi-display-update.service"
UPDATE_STATE_FILE = "/run/stackpi-display/update.state"
UPDATE_LOG_FILE = "/run/stackpi-display/update.log"
DEFAULT_BRANCH = "dev"
LOG_TAIL_LINES = 200
COMMITS_LIMIT_DEFAULT = 20
COMMITS_LIMIT_MAX = 100
# Branch/commit refs reach `git checkout`/`reset` in the privileged updater, so
# allow only safe git-ref characters (the updater re-validates too).
_REF_RE = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")


def _valid_ref(ref: str) -> bool:
    return bool(_REF_RE.match(ref or ""))


def _git(args: List[str], timeout: int = 10) -> str:
    proc = subprocess.run(
        ["git", "-C", str(cfg("repo_dir")), *args],
        capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {(proc.stderr or proc.stdout).strip()}")
    return proc.stdout.strip()


def _fetch() -> bool:
    try:
        _git(["fetch", "--quiet", "--prune", "origin"], timeout=20)
        return True
    except (RuntimeError, subprocess.SubprocessError, OSError) as e:
        log.info("update fetch failed (offline?): %s", e)
        return False


def _current_branch() -> str:
    try:
        b = _git(["rev-parse", "--abbrev-ref", "HEAD"])
        return b if b and b != "HEAD" else DEFAULT_BRANCH
    except (RuntimeError, subprocess.SubprocessError, OSError):
        return DEFAULT_BRANCH


def _list_branches() -> List[str]:
    try:
        out = _git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])
    except (RuntimeError, subprocess.SubprocessError, OSError):
        return []
    names = []
    for line in out.splitlines():
        name = line.strip()
        if not name or name.endswith("/HEAD"):
            continue
        names.append(name[len("origin/"):] if name.startswith("origin/") else name)
    return sorted(set(names))


def _list_commits(branch: str, limit: int) -> List[dict]:
    # NUL-separated records, \x1f-separated fields (safe for multi-line bodies).
    try:
        out = _git(["log", f"origin/{branch}", f"-n{int(limit)}",
                    "--format=%H%x1f%h%x1f%cI%x1f%an%x1f%B%x00"])
    except (RuntimeError, subprocess.SubprocessError, OSError):
        return []
    commits = []
    for record in out.split("\x00"):
        record = record.lstrip("\n")
        if not record.strip():
            continue
        parts = record.split("\x1f", 4)
        if len(parts) < 5:
            continue
        sha, short, date, author, body = parts
        body = body.strip("\n")
        commits.append({"sha": sha, "short": short, "date": date, "author": author,
                        "subject": body.splitlines()[0] if body else "", "body": body})
    return commits


def _update_run_state() -> str:
    try:
        with open(UPDATE_STATE_FILE, encoding="utf-8") as fh:
            return fh.read().strip() or "idle"
    except OSError:
        return "idle"


def _update_unit_active() -> bool:
    try:
        return subprocess.run(["systemctl", "is-active", "--quiet", UPDATE_UNIT],
                              timeout=5).returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def _update_effective_state() -> str:
    # A 'running' file with no live unit means the run died — report 'failed' so
    # the UI doesn't spin forever.
    state = _update_run_state()
    if state == "running" and not _update_unit_active():
        return "failed"
    return state


def _update_log_tail(lines: int = LOG_TAIL_LINES) -> str:
    try:
        with open(UPDATE_LOG_FILE, encoding="utf-8") as fh:
            return "\n".join(fh.read().splitlines()[-lines:])
    except OSError:
        return ""


def _update_status(branch: Optional[str], commit: Optional[str]) -> Dict[str, Any]:
    try:
        current = _git(["rev-parse", "HEAD"])
    except (RuntimeError, subprocess.SubprocessError, OSError) as e:
        return {"error": str(e), "state": _update_effective_state()}
    current_branch = _current_branch()
    branch = branch or current_branch
    fetch_ok = _fetch()
    target: Optional[str] = None
    behind = 0
    try:
        target = commit if commit else _git(["rev-parse", f"origin/{branch}"])
        behind = int(_git(["rev-list", "--count", f"HEAD..{target}"]))
    except (RuntimeError, ValueError, subprocess.SubprocessError, OSError) as e:
        log.info("update target lookup failed: %s", e)
    return {
        "branch": branch, "current_branch": current_branch,
        "current": current, "current_short": current[:7],
        "target": target, "target_short": target[:7] if target else None,
        "behind": behind, "update_available": bool(target and target != current),
        "fetch_ok": fetch_ok, "state": _update_effective_state(),
        "log_tail": _update_log_tail(),
    }


def _trigger_update(branch: Optional[str], commit: Optional[str]) -> None:
    cmd = ["sudo", "-n", UPDATER, "start"]
    if branch:
        cmd.append(branch)
        if commit:
            cmd.append(commit)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(f"updater exited {proc.returncode}: {(proc.stderr or '').strip()}")
    log.info("update trigger: %s", proc.stdout.strip())


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, body: Any, code: int = 200) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _same_origin(self, origin: str) -> bool:
        # Accept only an Origin whose host matches the Host header we answered on.
        host = (self.headers.get("Host") or "").split(":", 1)[0]
        try:
            ohost = urlparse(origin).hostname or ""
        except ValueError:
            return False
        return bool(host) and ohost == host

    def _read_json(self) -> Dict[str, Any]:
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            return {}

    def _q(self) -> Dict[str, str]:
        q = parse_qs(urlparse(self.path).query)
        return {k: v[0] for k, v in q.items()}

    # --- software update (mirrors the primary's /local/update) -------------
    def _update_get(self, path: str) -> None:
        q = self._q()
        branch = q.get("branch")
        commit = q.get("commit")
        if branch is not None and not _valid_ref(branch):
            self._json({"error": "invalid branch name"}, 400)
            return
        if commit is not None and not _valid_ref(commit):
            self._json({"error": "invalid commit"}, 400)
            return
        if path == "/api/update/branches":
            fetch_ok = _fetch()
            self._json({"current_branch": _current_branch(),
                        "branches": _list_branches(), "fetch_ok": fetch_ok})
            return
        if path == "/api/update/commits":
            if not branch:
                self._json({"error": "branch required"}, 400)
                return
            try:
                limit = max(1, min(COMMITS_LIMIT_MAX, int(q.get("limit", COMMITS_LIMIT_DEFAULT))))
            except ValueError:
                limit = COMMITS_LIMIT_DEFAULT
            _fetch()
            self._json({"branch": branch, "commits": _list_commits(branch, limit)})
            return
        if path == "/api/update/status":
            self._json(_update_status(branch, commit))
            return
        self._json({"error": "not found"}, 404)

    # --- GET ---------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/setup", "/setup/"):
            self._send_file(SETUP_HTML, "text/html; charset=utf-8")
            return
        if path == "/api/config":
            with _cfg_lock:
                self._json(dict(CONFIG))
            return
        if path == "/api/wifi/scan":
            self._json({"networks": wifi_scan()})
            return
        if path == "/api/net":
            self._json(net_status())
            return
        if path.startswith("/api/update"):
            self._update_get(path)
            return
        if path in SSE_PATHS:
            self._sse(SSE_PATHS[path])
            return
        if path.startswith("/local/"):
            body = emulate(path)
            self._json(body if body is not None else {})
            return
        self._static(path)

    # --- POST --------------------------------------------------------------
    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        # CSRF / drive-by guard: state-changing POSTs must be same-origin JSON.
        # The setup page always sends application/json from the device's own
        # origin; a form-POST from another page in the browser cannot set either.
        ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip()
        if ctype != "application/json":
            self._json({"ok": False, "error": "expected application/json"}, 415)
            return
        origin = self.headers.get("Origin")
        if origin and not self._same_origin(origin):
            self._json({"ok": False, "error": "cross-origin POST rejected"}, 403)
            return
        body = self._read_json()
        if path == "/api/config":
            updates: Dict[str, Any] = {}
            if "multicast_group" in body:
                grp = str(body["multicast_group"])
                try:
                    if not _is_multicast(grp):
                        raise ValueError
                except ValueError:
                    self._json({"ok": False, "error": "group must be IPv4 multicast"}, 400)
                    return
                updates["multicast_group"] = grp
            if "multicast_port" in body:
                updates["multicast_port"] = int(body["multicast_port"])
            if body.get("screen") in ("status", "trucks"):
                updates["screen"] = body["screen"]
            try:
                save_config(updates)
            except OSError as e:
                self._json({"ok": False, "error": f"could not write config: {e}"}, 500)
                return
            self._json({"ok": True, "config": dict(CONFIG)})
            return
        if path == "/api/wifi/connect":
            self._json(wifi_connect(str(body.get("ssid", "")), str(body.get("password", ""))))
            return
        if path == "/api/update/start":
            branch = body.get("branch") or None
            commit = body.get("commit") or None
            if branch is not None and not _valid_ref(str(branch)):
                self._json({"ok": False, "error": "invalid branch name"}, 400)
                return
            if commit is not None and not _valid_ref(str(commit)):
                self._json({"ok": False, "error": "invalid commit"}, 400)
                return
            if _update_unit_active():
                self._json({"ok": True, "started": False, "already_running": True, "state": "running"})
                return
            try:
                _trigger_update(branch, commit)
            except (RuntimeError, subprocess.SubprocessError, OSError) as e:
                log.exception("update start failed")
                self._json({"ok": False, "error": str(e)}, 500)
                return
            self._json({"ok": True, "started": True, "state": "running"})
            return
        self.send_error(404)

    def _sse(self, field: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            for item in (STORE.get().get(field) or []):
                self.wfile.write(f"data: {json.dumps(item)}\n\n".encode("utf-8"))
            self.wfile.flush()
            while True:
                time.sleep(15)
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def _static(self, path: str) -> None:
        web_dir = os.path.normpath(cfg("web_dir"))
        rel = path.lstrip("/") or "index.html"
        candidates = [rel]
        if not os.path.splitext(rel)[1]:
            candidates += [rel + ".html", os.path.join(rel, "index.html")]
        for c in candidates:
            fp = os.path.normpath(os.path.join(web_dir, c))
            if fp.startswith(web_dir) and os.path.isfile(fp):
                self._send_file(fp)
                return
        fallback = os.path.join(web_dir, "status.html")
        if os.path.isfile(fallback):
            self._send_file(fallback)
            return
        self.send_error(404)

    def _send_file(self, fp: str, ctype: Optional[str] = None) -> None:
        try:
            with open(fp, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype or _content_type(fp))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _is_multicast(ip: str) -> bool:
    try:
        first = int(ip.split(".")[0])
        return 224 <= first <= 239 and ip.count(".") == 3
    except (ValueError, IndexError):
        return False


def _content_type(fp: str) -> str:
    ext = os.path.splitext(fp)[1].lower()
    return {
        ".html": "text/html; charset=utf-8", ".js": "text/javascript",
        ".css": "text/css", ".json": "application/json", ".png": "image/png",
        ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon",
    }.get(ext, "application/octet-stream")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    load_config()
    threading.Thread(target=multicast_listener, daemon=True).start()
    # Bind to localhost only. The kiosk browser runs ON this device and reaches
    # the receiver via localhost; the admin surface (/setup, /api/config,
    # /api/wifi/*) is sensitive and must NOT be exposed unauthenticated on the
    # LAN. Reach /setup remotely via an SSH tunnel until LAN auth is added.
    httpd = ThreadingHTTPServer(("127.0.0.1", int(cfg("http_port"))), Handler)
    log.info("serving on http://127.0.0.1:%s (kiosk + /setup)", cfg("http_port"))
    httpd.serve_forever()


if __name__ == "__main__":
    main()
