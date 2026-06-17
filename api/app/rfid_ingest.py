"""POST /rfid-tags — endpoint the Zebra IoT Connector posts tag events to.

The reader is configured (via its Cloud Connect / Endpoints page in the
admin) to ship JSON like:

    {
      "type": "SIMPLE",
      "timestamp": "2026-06-03T19:21:21Z",
      "data": {
        "CRC": "b06a", "PC": "3000", "TID": "...", "USER": "...",
        "antenna": 1, "channel": 911.75, "eventNum": 1,
        "format": "epc", "idHex": "3005fb63...",
        "peakRssi": -39, "phase": 0, "reads": 1, "XPC": "string",
        "accessResults": ["SUCCESS"]
      }
    }

We persist one row per event with each field broken out into its own
typed column AND the original payload retained in `raw_json` (so we
never lose anything the reader sent — forward-compatible).

Accepts either a single JSON object or an array of them so batched
deliveries work. Looks up `reader_id` by matching the source IP against
`local_rfid_readers.address`.

No auth — same LAN-trust posture as the rest of /local/*.
"""
import logging
from typing import Any, List, Optional

import psycopg
from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb

log = logging.getLogger(__name__)

router = APIRouter(tags=["rfid-ingest"])

DB_URL = "postgresql://csg:csg@localhost:5432/stackpi"


# ---------------------------------------------------------------------------
# Field extraction helpers
# ---------------------------------------------------------------------------

def _to_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _to_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _flatten(event: dict) -> dict:
    """Pull the columns we care about out of a single Zebra event dict.
    Unknown / missing fields land as NULL; everything raw is kept in raw_json."""
    data = event.get("data") or {}
    return {
        "event_type":      event.get("type"),
        "event_timestamp": event.get("timestamp"),  # psycopg parses ISO strings
        "event_num":       _to_int(data.get("eventNum")),
        "id_hex":          data.get("idHex"),
        "tid":             data.get("TID"),
        "user_data":       data.get("USER"),
        "crc":             data.get("CRC"),
        "pc":              data.get("PC"),
        "xpc":             data.get("XPC"),
        "antenna":         _to_int(data.get("antenna")),
        "channel_mhz":     _to_float(data.get("channel")),
        "event_format":    data.get("format"),
        "peak_rssi":       _to_int(data.get("peakRssi")),
        "phase":           _to_float(data.get("phase")),
        "reads":           _to_int(data.get("reads")),
    }


_INSERT_SQL = """
INSERT INTO local_rfid_raw_scans (
    reader_id, received_at, event_type, event_timestamp, event_num,
    id_hex, tid, user_data, crc, pc, xpc,
    antenna, channel_mhz, event_format,
    peak_rssi, phase, reads, access_results, raw_json
) VALUES (
    %(reader_id)s, NOW(), %(event_type)s, %(event_timestamp)s, %(event_num)s,
    %(id_hex)s, %(tid)s, %(user_data)s, %(crc)s, %(pc)s, %(xpc)s,
    %(antenna)s, %(channel_mhz)s, %(event_format)s,
    %(peak_rssi)s, %(phase)s, %(reads)s, %(access_results)s, %(raw_json)s
)
RETURNING id
"""


@router.post("/rfid-tags")
async def ingest_tags(request: Request) -> dict:
    """Accept a single Zebra event object or an array. Returns the count
    actually inserted."""
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid JSON: {e}")

    if isinstance(body, dict):
        events: List[Any] = [body]
    elif isinstance(body, list):
        events = body
    else:
        raise HTTPException(
            status_code=400,
            detail="body must be a JSON object or array",
        )

    if not events:
        return {"ok": True, "ingested": 0, "reader_id": None}

    src_ip = request.client.host if request.client else None

    inserted = 0
    try:
        with psycopg.connect(DB_URL) as conn:
            with conn.cursor() as cur:
                # Soft-match reader by source IP. NULL is fine if no match.
                reader_id: Optional[int] = None
                if src_ip:
                    cur.execute(
                        "SELECT id FROM local_rfid_readers "
                        "WHERE address = %s ORDER BY id LIMIT 1",
                        (src_ip,),
                    )
                    row = cur.fetchone()
                    if row:
                        reader_id = row[0]

                reader_name: Optional[str] = None
                if reader_id is not None:
                    cur.execute(
                        "SELECT name FROM local_rfid_readers WHERE id = %s",
                        (reader_id,),
                    )
                    nrow = cur.fetchone()
                    reader_name = nrow[0] if nrow else None
                # Bad-tag alert candidates collected in-transaction, fired
                # post-commit: (id_hex, serial, name).
                alert_candidates: list = []

                # Lazy import: keeps the ingest module decoupled from the
                # match registry at import time (and avoids a circular ref
                # if process_scan ever pulls in something from this module).
                from app.rfid_scan_processing import process_scan  # noqa: PLC0415

                for ev in events:
                    if not isinstance(ev, dict):
                        continue
                    params = _flatten(ev)
                    data = ev.get("data") or {}
                    access = data.get("accessResults")
                    params["access_results"] = (
                        Jsonb(access) if access is not None else None
                    )
                    params["raw_json"] = Jsonb(ev)
                    params["reader_id"] = reader_id
                    cur.execute(_INSERT_SQL, params)
                    scan_row = cur.fetchone()
                    if scan_row is not None:
                        # Run the lookup registry in the same transaction
                        # so the local_rfid_matches row (if any) commits
                        # atomically with the raw scan. The SSE join is
                        # therefore race-free.
                        match = process_scan(
                            cur,
                            scan_id=int(scan_row[0]),
                            id_hex=params["id_hex"],
                            reader_id=reader_id,
                        )
                        # Bad-tag check: a known asset (in local_asset_tags)
                        # that did NOT match the active move (no asset match)
                        # → flag it. Membership is an O(1) PK lookup.
                        if not (match and match.get("match_type") == "asset"):
                            cur.execute(
                                "SELECT serial, name FROM local_asset_tags "
                                "WHERE id_hex = %s",
                                (params["id_hex"],),
                            )
                            arow = cur.fetchone()
                            if arow is not None:
                                alert_candidates.append(
                                    (params["id_hex"], arow[0], arow[1])
                                )
                    inserted += 1
            conn.commit()

            # Post-commit: fire bad-tag alerts (sound + System Event),
            # debounced per tag. After commit so audio / event I/O never
            # holds the ingest transaction.
            if alert_candidates:
                from app import alerts  # noqa: PLC0415
                for a_id_hex, a_serial, a_name in alert_candidates:
                    alerts.fire(
                        a_id_hex,
                        serial=a_serial,
                        name=a_name,
                        reader_name=reader_name,
                    )
    except psycopg.Error as e:
        log.exception("rfid-tags insert failed")
        raise HTTPException(status_code=500, detail=f"DB error: {e}")

    return {"ok": True, "ingested": inserted, "reader_id": reader_id}
