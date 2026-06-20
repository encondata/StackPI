# esp_stacklight

Docs (and, later, firmware) for the **ESP-based stack light / buzzer** that
receives StackPI notifications.

StackPI sends notifications as **JSON over UDP multicast**. The ESP joins the
multicast group, parses each datagram, and drives its LEDs / buzzer
accordingly. There is no handshake and no reply — it's a one-way, best-effort
broadcast.

- **[notification-protocol.md](notification-protocol.md)** — the full spec:
  transport (multicast group/port/TTL), the JSON message schema (`light` /
  `sound`), examples, behavior, and the intended event → message mapping.

## Quick reference

| | |
|---|---|
| Transport | UDP, IPv4 multicast, one JSON message per datagram (UTF-8) |
| Default group | `239.10.10.10` |
| Default port | `5005` |
| TTL | `1` (same LAN segment) |
| Schema version | `1` (the `v` field) |

Group / port / enable are operator-editable on the StackPI admin UI at
**`/config → Settings → Notifications`**, which also has Send-test buttons for
light and sound. The sender lives in `api/app/notifier.py`.
