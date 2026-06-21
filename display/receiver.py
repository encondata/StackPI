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
import socket
import struct
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

log = logging.getLogger("stackpi.display.receiver")

CONFIG_PATH = os.environ.get("STACKPI_DISPLAY_CONFIG", "/etc/stackpi-display/config.json")
SETUP_HTML = os.environ.get("STACKPI_DISPLAY_SETUP", "/opt/stackpi-display/setup.html")
DEFAULTS = {
    "multicast_group": "239.10.10.11",
    "multicast_port": 5006,
    "http_port": 8080,
    "web_dir": "/opt/stackpi-display/web",
    "screen": "status",
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
    except (subprocess.SubprocessError, OSError) as e:
        return {"ok": False, "error": str(e)}
    return {"ok": p.returncode == 0, "output": (p.stdout or p.stderr).strip()[:300]}


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

    def _read_json(self) -> Dict[str, Any]:
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            return {}

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
    httpd = ThreadingHTTPServer(("0.0.0.0", int(cfg("http_port"))), Handler)
    log.info("serving on http://0.0.0.0:%s (kiosk + /setup)", cfg("http_port"))
    httpd.serve_forever()


if __name__ == "__main__":
    main()
