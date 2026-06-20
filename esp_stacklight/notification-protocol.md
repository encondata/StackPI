# StackPI → stack-light notification protocol

How StackPI notifies a networked stack light / buzzer. One-way, best-effort,
JSON over UDP multicast. Source of truth: `api/app/notifier.py`.

## Transport

- **UDP, IPv4 multicast.** Each notification is **one datagram** containing a
  single JSON object, encoded **UTF-8**, with no framing/length prefix.
- **Default group:** `239.10.10.10` · **Default port:** `5005`. Both are
  operator-configurable (StackPI `/config → Settings → Notifications`), so the
  firmware should make group+port configurable rather than hardcoding them.
- **TTL = 1** — notifications stay on the local segment; the stack light must be
  on the same LAN/VLAN as the Pi.
- **No ACK, no retransmit, no ordering guarantees.** UDP multicast is lossy by
  design (see [Behavior](#behavior)).
- A notification only goes out when StackPI's notifier is **enabled** (the
  `/config` toggle). The page's *test* buttons always send regardless.

### Receiving (ESP, conceptually)

```
join multicast group 239.10.10.10 on UDP port 5005
loop:
  datagram = recv()                 # up to ~512 bytes is plenty
  msg = json_parse(datagram)
  if msg.v != 1: ignore (unknown schema version)
  switch msg.type:
    "light": drive LEDs (color, pattern, brightness, duration, repeat_count)
    "sound": drive buzzer (sound, volume, duration, repeat_count)
    default: ignore
```

## Message schema

Every message has:

| field | type | notes |
|---|---|---|
| `v` | int | schema version — currently `1`. Ignore messages with a version you don't understand. |
| `type` | string | `"light"` or `"sound"`. |

### `light`

```json
{ "v": 1, "type": "light",
  "pattern": "flash", "color": "red",
  "brightness": 80, "duration": 500, "repeat_count": 3 }
```

| field | type | range / values | meaning |
|---|---|---|---|
| `pattern` | string | `solid` \| `flash` \| `pulse` | how the light animates |
| `color` | string | `red` \| `green` \| `yellow` \| `blue` | which lamp/color |
| `brightness` | int | `0`–`100` | percent |
| `duration` | int | milliseconds | on-time (`solid`) or one cycle's period (`flash`/`pulse`) |
| `repeat_count` | int | `1`–`5` | number of cycles |

### `sound`

```json
{ "v": 1, "type": "sound",
  "sound": "alert", "volume": 70, "duration": 400, "repeat_count": 2 }
```

| field | type | range / values | meaning |
|---|---|---|---|
| `sound` | string | ≤40 chars | sound/tone identifier the device maps to its own audio (e.g. `alert`, `error`, `info`) |
| `volume` | int | `0`–`100` | percent |
| `duration` | int | milliseconds | tone length / one cycle |
| `repeat_count` | int | `1`–`5` | number of repeats |

> The sender range-validates every field, so a well-formed message always falls
> in these bounds. The firmware should still clamp defensively.

## Behavior

- **Best-effort / lossy.** A dropped datagram is never resent. For *state*-style
  signals (e.g. the traffic-light color), expect StackPI to re-send periodically
  (planned) so a missed packet self-heals; the light should simply hold its last
  state until the next message.
- **Idempotent.** Re-applying the same message must be harmless — receiving the
  same "solid red" twice just stays solid red.
- **Latest wins.** A newer message supersedes the previous one for that channel
  (light vs sound are independent).
- **Forward-compatible.** Unknown `type` values or `v` numbers must be ignored,
  not error. New optional fields may appear; ignore what you don't recognize.

## Intended event → message mapping (planned)

The first integration pass (not yet wired) maps StackPI events to messages:

| event | light | sound |
|---|---|---|
| Bad tag (asset not in active move) | `flash` `red` | `alert` |
| Reader **offline** | `solid` `red` | — |
| Reader **degraded** | `solid` `yellow` | — |
| Reader **online** (idle) | `solid` `blue` | — |
| Reader **reading** | `solid` `green` | — |

(Colors mirror the `/status` page traffic light. 3-color stack lights have no
blue; the mapping will respect the configured `stacklight_enable` type.)
