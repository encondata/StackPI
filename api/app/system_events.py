"""System-events emit helper.

Any Pi-side subsystem that wants to surface a notification on the /status
page's System Events panel calls emit(...). The row lands in
`local_system_events`; the SSE endpoint at
GET /local/system-events/stream tails the table and pushes each new row
to subscribers in real time.

Producers should treat this as fire-and-forget — emit() never raises,
DB failures are logged and swallowed so a notification path can't crash
the calling subsystem.
"""
import logging
import subprocess
from typing import Optional

log = logging.getLogger(__name__)

DB_NAME = "stackpi"
DB_USER = "csg"
PSQL_TIMEOUT_SECONDS = 5

KIND_SUCCESS = "success"
KIND_ERROR   = "error"
KIND_INFO    = "info"


def emit(
    source: str,
    kind: str,
    message: str,
    detail: Optional[str] = None,
) -> bool:
    """Append one row to local_system_events. Returns True on success;
    False (with a log warning) on any DB failure. Never raises."""
    if not source or not kind or not message:
        log.warning("emit: source/kind/message all required (got %r/%r/%r)",
                    source, kind, message)
        return False

    # Values are bound via psql -v + :'name' so embedded quotes don't break
    # the statement. Keys (column names) are controlled constants.
    cmd = [
        "psql", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1",
        "-v", f"source={source}",
        "-v", f"kind={kind}",
        "-v", f"message={message[:1000]}",
        "-v", f"detail={detail[:4000] if detail else ''}",
    ]
    sql = (
        "INSERT INTO local_system_events (source, kind, message, detail) "
        "VALUES (:'source', :'kind', :'message', NULLIF(:'detail', ''))"
    )
    try:
        proc = subprocess.run(
            cmd,
            input=sql,
            capture_output=True,
            text=True,
            timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("emit: psql invocation failed: %s", e)
        return False
    if proc.returncode != 0:
        log.warning(
            "emit: psql exit=%d stderr=%s",
            proc.returncode, proc.stderr.strip(),
        )
        return False

    # Nudge the status broadcaster so remote displays see the new event promptly.
    try:
        from app import status_broadcast  # noqa: PLC0415
        status_broadcast.mark_dirty()
    except Exception:  # pragma: no cover
        pass

    # Play the mapped audio cue on the Pi speaker (error/alert/info), best-effort.
    try:
        from app import audio  # noqa: PLC0415
        audio.on_event(kind, detail)
    except Exception:  # pragma: no cover
        pass

    return True
