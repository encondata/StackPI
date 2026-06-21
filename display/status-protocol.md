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
- **Cadence (v2 — diff + keyframe):** to keep datagrams small, the primary sends
  a compact **`delta`** whenever something changes (and nothing on the wire when
  idle), plus a full **`full` keyframe every 30 seconds** so a just-booted or
  lossy receiver re-syncs. Change detection runs at least every 5s; a new RFID
  scan / system event triggers an immediate (debounced) delta.
- **Best-effort:** no ACK / retransmit. A missed datagram self-heals on the next
  30s keyframe. A `full` may exceed one Ethernet frame and get IP-fragmented —
  fine on a quiet LAN. Deltas are small.

## Messages — `status`

Both messages share `v`, `type:"status"`, and `ts`. `kind` distinguishes them.

### `full` (keyframe) — the complete snapshot

```jsonc
{
  "v": 2,
  "type": "status",
  "kind": "full",
  "ts": "2026-06-21T15:04:05.123456+00:00",   // when built (UTC ISO-8601)
  "metrics": {                                  // card values for /status AND /trucks
    "tags_today": 0, "unique_tags_today": 0,
    "readers_up": 0, "readers_total": 0,
    "assets_total": 0, "assets_matched": 0,
    "last_sync": "…|null"
  },
  "reader": { "state": "offline|degraded|online|reading", "name": "…", "configured": true },
  "registration": { "status": "registered|offline|unregistered|unknown", "name": "…" },
  "activity": [ /* up to 20 recent resolved RFID matches, newest first */ ],
  "events":   [ /* up to 20 recent system events, newest first:
                   {id, emitted_at, source, kind, message, detail} */ ],
  "uptime": 12345                               // primary's uptime in seconds
}
```

### `delta` — only what changed

```jsonc
{
  "v": 2, "type": "status", "kind": "delta", "ts": "…",
  "metrics": { … },          // present only if a card value changed (whole section)
  "reader": { … },           // present only if it changed
  "registration": { … },     // present only if it changed
  "activity_new": [ … ],     // ONLY the new activity items to prepend (by id)
  "events_new":   [ … ],     // ONLY the new event items to prepend (by id)
  "uptime": 12345            // current uptime (rides whatever we send)
}
```

Any section absent from a delta is unchanged. `uptime` is **not** part of change
detection (it ticks every second) — it rides keyframes and any delta already
being sent; the page ticks it locally in between.

Sections can also be **omitted entirely** by the operator via the *what-to-send*
tick boxes (`/config → Settings → Notifications` on the primary); an omitted
section simply never appears.

## Behavior (receiver)

- **`full` replaces** the whole stored snapshot. **`delta` merges:** replace any
  scalar section present (`metrics`/`reader`/`registration`), prepend
  `activity_new`/`events_new` to the feeds (dedupe by `id`, cap 20), update
  `uptime`/`ts`.
- **Ignore unknown** `type` values; a message with no `kind` is treated as a full
  snapshot (v1 back-compat).
- **Hold last state** if updates stop (a missed delta self-heals at the next 30s
  keyframe).
- Browsers can't read multicast directly — the local receiver on the display Pi
  bridges datagrams to the page (emulated `/local/*` endpoints + SSE).
