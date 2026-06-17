"""rfid_scan_processing — resolve a raw RFID id_hex against known sources.

Registry pattern. Each entry in ``LOOKUPS`` is a function that checks one
source table and returns either a match dict (with a ``match_type`` key
and a flat set of display fields) or ``None``. First hit wins; ties are
broken by registry order, so put higher-priority sources first.

Adding a new source (e.g. visitors, contractors, equipment) is a two-step
job: write a new ``_lookup_<source>(cur, id_hex)`` and append it to
``LOOKUPS``. The persistence + SSE plumbing doesn't need to change — the
match_type string from the lookup propagates straight through.

Called inline from the /rfid-tags ingest path so a matched scan and its
``local_rfid_matches`` row land in the SAME transaction as the raw scan.
The /local/rfid/matches/stream SSE can therefore JOIN to local_rfid_raw_scans
without race-window blind spots.
"""
import logging
from typing import Any, Callable, Dict, List, Optional

import psycopg
from psycopg.types.json import Jsonb

log = logging.getLogger(__name__)


LookupFn = Callable[[psycopg.Cursor, str], Optional[Dict[str, Any]]]


def _lookup_asset(cur: psycopg.Cursor, id_hex: str) -> Optional[Dict[str, Any]]:
    """Match against cloud_sync_moves_assets.asset_rfid_tag. An asset can
    appear under multiple moves; we don't care which row hit — the
    denormalized display fields are the same on each."""
    cur.execute(
        """
        SELECT asset_serial_number, asset_make, asset_model
        FROM   cloud_sync_moves_assets
        WHERE  asset_rfid_tag = %s
        ORDER  BY id
        LIMIT  1
        """,
        (id_hex,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return {
        "match_type":          "asset",
        "asset_serial_number": row[0],
        "asset_make":          row[1],
        "asset_model":         row[2],
    }


def _lookup_person(cur: psycopg.Cursor, id_hex: str) -> Optional[Dict[str, Any]]:
    """Match against cloud_sync_people.rfid_tracker. Composes a Name out
    of (first_name | display_name) + last_name per the original spec."""
    cur.execute(
        """
        SELECT first_name, display_name, last_name
        FROM   cloud_sync_people
        WHERE  rfid_tracker = %s
        ORDER  BY id
        LIMIT  1
        """,
        (id_hex,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    first, display, last = row
    # Spec: "first_name or if not null then display_name". Prefer first_name
    # when present, fall back to display_name otherwise. Then concat last_name.
    given = (first or "").strip() or (display or "").strip()
    last_clean = (last or "").strip()
    name = " ".join(p for p in (given, last_clean) if p) or None
    return {
        "match_type": "person",
        "name":       name,
    }


# Order matters: first hit wins. Assets first because the operational
# focus is on tracking inventory through the move; people are secondary.
LOOKUPS: List[LookupFn] = [
    _lookup_asset,
    _lookup_person,
]


_INSERT_MATCH_SQL = """
INSERT INTO local_rfid_matches (
    scan_id, reader_id, id_hex, match_type, match_data
) VALUES (
    %(scan_id)s, %(reader_id)s, %(id_hex)s, %(match_type)s, %(match_data)s
)
RETURNING id
"""

# Stages the matched scan for upload to BaseCamp by mirroring the raw
# scan row into local_rfid_processed_scans. INSERT…SELECT keeps the copy
# atomic in one SQL trip and avoids re-marshalling typed columns through
# Python. reader_name is snapshotted at insert via the LEFT JOIN; raw_scan
# columns are pulled straight from the source row by id.
_INSERT_PROCESSED_SQL = """
INSERT INTO local_rfid_processed_scans (
    raw_scan_id, match_id, reader_id, reader_name,
    received_at, event_type, event_timestamp, event_num,
    id_hex, tid, user_data, crc, pc, xpc,
    antenna, channel_mhz, event_format,
    peak_rssi, phase, reads, access_results, raw_json,
    match_type, match_data
)
SELECT
    s.id, %(match_id)s, s.reader_id, r.name,
    s.received_at, s.event_type, s.event_timestamp, s.event_num,
    s.id_hex, s.tid, s.user_data, s.crc, s.pc, s.xpc,
    s.antenna, s.channel_mhz, s.event_format,
    s.peak_rssi, s.phase, s.reads, s.access_results, s.raw_json,
    %(match_type)s, %(match_data)s
FROM local_rfid_raw_scans s
LEFT JOIN local_rfid_readers r ON r.id = s.reader_id
WHERE s.id = %(raw_scan_id)s
"""


def match_id_hex(cur: psycopg.Cursor, id_hex: str) -> Optional[Dict[str, Any]]:
    """Walk LOOKUPS, return the first match dict or None. A lookup raising
    psycopg.Error is logged and treated as no-match so one broken source
    doesn't block the others — the raw scan still persists either way."""
    if not id_hex:
        return None
    for fn in LOOKUPS:
        try:
            hit = fn(cur, id_hex)
        except psycopg.Error:
            log.exception("rfid_scan_processing: %s raised; skipping", fn.__name__)
            continue
        if hit is not None:
            return hit
    return None


def process_scan(
    cur: psycopg.Cursor,
    scan_id: int,
    id_hex: Optional[str],
    reader_id: Optional[int],
) -> Optional[Dict[str, Any]]:
    """Resolve `id_hex` and persist a local_rfid_matches row on hit.

    Runs in the caller's transaction (no commit). Returns the match dict
    augmented with ``match_id`` on success, or None on no-match. Insert
    failures are logged but not re-raised — a broken match log shouldn't
    cause the raw scan ingest to roll back."""
    if not id_hex:
        return None
    match = match_id_hex(cur, id_hex)
    if match is None:
        return None
    try:
        cur.execute(
            _INSERT_MATCH_SQL,
            {
                "scan_id":    int(scan_id),
                "reader_id":  reader_id,
                "id_hex":     id_hex,
                "match_type": match["match_type"],
                "match_data": Jsonb(match),
            },
        )
        row = cur.fetchone()
        if row is None:
            return None
        match["match_id"] = int(row[0])

        # Stage for upload — same transaction so a power loss never leaves
        # us with a match row but no upload queue entry. sync_validated
        # defaults to 'pending' at the DB level; the uploader takes it from
        # there. Failure here is logged but does NOT roll back the match
        # row — a broken upload queue is recoverable; a missing match would
        # corrupt the user-visible activity feed.
        cur.execute(
            _INSERT_PROCESSED_SQL,
            {
                "raw_scan_id": int(scan_id),
                "match_id":    int(row[0]),
                "match_type":  match["match_type"],
                "match_data":  Jsonb(match),
            },
        )
    except psycopg.Error:
        log.exception("rfid_scan_processing: match/processed insert failed")
        return None
    return match
