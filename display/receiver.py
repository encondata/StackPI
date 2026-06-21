#!/usr/bin/env python3
"""StackPI status-display receiver.

Runs on a remote display Pi. Listens for the primary's status snapshot on UDP
multicast and serves it back to a local kiosk browser by EMULATING the handful
of /local/* endpoints (and SSE streams) that the reused portal /status + /trucks
pages call — so those pages run unchanged, just pointed at this localhost server.

stdlib only (no pip): socket + http.server + threading. Config from
/etc/stackpi-display/config.json (see config.example.json).

See ../display/status-protocol.md for the snapshot schema.
"""
import json
import logging
import os
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

log = logging.getLogger("stackpi.display.receiver")

CONFIG_PATH = os.environ.get("STACKPI_DISPLAY_CONFIG", "/etc/stackpi-display/config.json")
DEFAULTS = {
    "multicast_group": "239.10.10.11",
    "multicast_port": 5006,
    "http_port": 8080,
    "web_dir": "/opt/stackpi-display/web",  # the exported portal (/status, /trucks, _next)
}


def load_config() -> Dict[str, Any]:
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    except (OSError, ValueError) as e:
        log.warning("config %s not loaded (%s); using defaults", CONFIG_PATH, e)
    return cfg


# ---------------------------------------------------------------------------
# Latest-snapshot store (written by the multicast thread, read by HTTP)
# ---------------------------------------------------------------------------

class SnapshotStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snap: Dict[str, Any] = {}
        self._received_at: float = 0.0

    def set(self, snap: Dict[str, Any]) -> None:
        with self._lock:
            self._snap = snap
            self._received_at = time.time()

    def get(self) -> Dict[str, Any]:
        with self._lock:
            return self._snap

    def age(self) -> float:
        with self._lock:
            return time.time() - self._received_at if self._received_at else 1e9


STORE = SnapshotStore()


def multicast_listener(group: str, port: int) -> None:
    """Join the multicast group and feed every status datagram into STORE.
    Reconnects on error. Runs forever in its own thread."""
    while True:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("", port))
            mreq = struct.pack("4sl", socket.inet_aton(group), socket.INADDR_ANY)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
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
            log.warning("multicast listener error: %s; retrying in 3s", e)
            time.sleep(3)


# ---------------------------------------------------------------------------
# Snapshot → emulated /local/* endpoint responses
# ---------------------------------------------------------------------------

def _readers_from_snapshot(snap: Dict[str, Any]) -> Dict[str, Any]:
    """Synthesize the /local/rfid/readers payload from the snapshot's reader
    summary so the /status traffic light renders. Best-effort shape."""
    r = snap.get("reader") or {}
    state = r.get("state")
    if not r.get("name"):
        return {"readers": []}
    # The page derives red/yellow/blue/green from last_error/last_status; we
    # already have the derived state, so map it back to a minimal status object.
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
            {
                "id": 1,
                "name": r.get("name"),
                "enabled": True,
                "last_error": last_error,
                "last_status": last_status,
                "last_status_at": snap.get("ts"),
            }
        ]
    }


def emulate(path: str) -> Optional[Any]:
    """Return the emulated JSON body for a /local/* GET path, or None if we
    don't emulate it (caller 404s / stubs). Driven entirely by the latest
    snapshot; missing pieces fall back to sensible empties so the pages render."""
    snap = STORE.get()
    if path == "/local/metrics":
        return snap.get("metrics") or {}
    if path == "/local/status":
        reg = snap.get("registration") or {}
        return {"registration": reg, "status": reg.get("status", "unknown")}
    if path == "/local/rfid/readers":
        return _readers_from_snapshot(snap)
    if path in ("/local/settings", "/local/rfid/settings"):
        return {}  # display has no local settings; pages default
    if path == "/local/settings/screen-status":
        # Animations/borders off on the display; pages fall back to defaults.
        return {}
    return None


SSE_PATHS = {
    "/local/system-events/stream": "events",
    "/local/rfid/matches/stream": "activity",
    "/local/rfid/scans/stream": "activity",
}


# ---------------------------------------------------------------------------
# HTTP server: static export + emulated endpoints + SSE
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    web_dir = DEFAULTS["web_dir"]

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

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]

        if path in SSE_PATHS:
            self._sse(SSE_PATHS[path])
            return
        if path.startswith("/local/"):
            body = emulate(path)
            self._json(body if body is not None else {}, 200 if body is not None else 200)
            return
        self._static(path)

    def _sse(self, field: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            # Send the current items once, then keepalive. (Cards stay live via
            # the page's polling of /local/metrics; richer live-append is a
            # follow-up.)
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
        # Map a route to a file in the exported portal. Next export writes
        # /status.html (or /status/index.html); try both, default to index.html.
        rel = path.lstrip("/") or "index.html"
        candidates = [rel]
        if not os.path.splitext(rel)[1]:
            candidates += [rel + ".html", os.path.join(rel, "index.html")]
        for c in candidates:
            fp = os.path.normpath(os.path.join(self.web_dir, c))
            if fp.startswith(self.web_dir) and os.path.isfile(fp):
                self._send_file(fp)
                return
        # SPA-ish fallback to status
        fallback = os.path.join(self.web_dir, "status.html")
        if os.path.isfile(fallback):
            self._send_file(fallback)
            return
        self.send_error(404)

    def _send_file(self, fp: str) -> None:
        ctype = _content_type(fp)
        try:
            with open(fp, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _content_type(fp: str) -> str:
    ext = os.path.splitext(fp)[1].lower()
    return {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".ico": "image/x-icon",
    }.get(ext, "application/octet-stream")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config()
    Handler.web_dir = os.path.normpath(cfg["web_dir"])

    t = threading.Thread(
        target=multicast_listener,
        args=(cfg["multicast_group"], int(cfg["multicast_port"])),
        daemon=True,
    )
    t.start()

    httpd = ThreadingHTTPServer(("127.0.0.1", int(cfg["http_port"])), Handler)
    log.info("serving %s on http://127.0.0.1:%s", cfg["web_dir"], cfg["http_port"])
    httpd.serve_forever()


if __name__ == "__main__":
    main()
