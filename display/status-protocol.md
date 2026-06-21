# StackPI status broadcast protocol

How the primary StackPI broadcasts its status to remote displays. One-way,
best-effort, JSON over UDP multicast. Source of truth:
`api/app/status_broadcast.py`.

## Transport

- **UDP, IPv4 multicast.** One JSON object per datagram, UTF-8.
- **Default group:** `239.10.10.11` · **Default port:** `5006` — distinct from
  the stack-light notifier (`239.10.10.10:5005`) so lights and displays don't
  receive each other's traffic. Both configurable on the primary
  (`/config → Settings → Notifications`).
- **TTL = 1** — same LAN segment only.
- **Cadence:** a **5-second heartbeat** plus **on-change** (a new RFID scan or
  system event triggers an immediate emit). So a just-booted display syncs
  within 5s, and changes show up promptly.
- **Best-effort:** no ACK / retransmit. A missed (or lost-fragment) datagram
  self-heals on the next heartbeat. The snapshot may exceed one Ethernet frame
  and get IP-fragmented — fine on a quiet LAN.

## Message — `status` snapshot

```jsonc
{
  "v": 1,
  "type": "status",
  "ts": "2026-06-21T15:04:05.123456+00:00",   // when the snapshot was built (UTC ISO-8601)
  "metrics": {                                  // card values for /status AND /trucks
    "tags_today": 0, "unique_tags_today": 0,
    "readers_up": 0, "readers_total": 0,
    "assets_total": 0, "assets_matched": 0,
    "pending_sync": 0, "last_sync": "…|null", "errors_24h": 0,
    "total_trucks": 0, "trucks_in_motion": 0, "next_truck_eta": "…"
  },
  "reader": { "state": "offline|degraded|online|reading", "name": "…", "configured": true },
  "registration": { "status": "registered|offline|unregistered|unknown", "name": "…" },
  "activity": [ /* up to 20 recent resolved RFID matches, newest first */ ],
  "events":   [ /* up to 20 recent system events, newest first:
                   {id, emitted_at, source, kind, message, detail} */ ]
}
```

The snapshot is shaped to feed the existing `/status` + `/trucks` UI components
directly: the metric cards bind `metrics`, the traffic light binds `reader`, the
activity feed binds `activity`, etc.

## Behavior (receiver)

- **Latest wins.** Each snapshot fully replaces the displayed state; just render
  the most recent one received.
- **Ignore unknown** `type`/`v` values rather than erroring (forward-compat).
- **Hold last state** if updates stop (e.g. show a "stale since …" hint after a
  few missed heartbeats).
- Browsers can't read multicast directly — a small local receiver on the display
  Pi bridges the datagram to the page (localhost SSE/websocket, or a JSON file
  the page polls on localhost).
