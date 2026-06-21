# Multicast Listener — Design

**Date:** 2026-06-21
**Location:** `multicast_listener/`

## Purpose

Listen for multicast JSON messages on a specified IP group and port, pretty-print
each received message to the terminal using `rich`, and run until interrupted
(Ctrl-C). IP group and port are taken from command-line arguments, falling back
to built-in defaults when not supplied. Runs on macOS.

## Files

- `listener.py` — the multicast listener (primary deliverable)
- `sender.py` — small test helper that sends sample JSON to the group, for local
  verification without the RFID reader
- `requirements.txt` — pins `rich`

## Defaults

```python
DEFAULT_GROUP = "239.10.10.10"
DEFAULT_PORT  = 5005
```

## Components (listener.py)

1. **Arg parsing** — `argparse` with optional positional `group` and `port`
   (also available as `--group`/`--port`). Missing values fall back to the
   `DEFAULT_*` constants.
2. **Socket setup** — UDP socket; `SO_REUSEADDR`; bind to the port; join the
   multicast group via `setsockopt(IPPROTO_IP, IP_ADD_MEMBERSHIP, ...)`.
3. **Receive loop** — `recvfrom(65535)` in `while True`; decode bytes (UTF-8,
   `errors="replace"`).
4. **Render** — attempt `json.loads`. On success, print a `rich` panel: header
   with timestamp + sender `host:port`, body is syntax-highlighted JSON
   (`rich.json.JSON` / `Syntax`). On JSON parse failure, print the raw payload
   in a visually distinct (red) panel so nothing is silently dropped.
5. **Shutdown** — `KeyboardInterrupt` handler drops multicast membership,
   closes the socket, prints a clean exit line.

## Data Flow

```
CLI args / defaults -> socket bound + joined to group
   -> recvfrom() -> decode -> json.loads
       -> success: rich JSON panel
       -> failure: raw red panel
   -> (loop) ... -> Ctrl-C -> leave group, close, exit
```

## Error Handling

- Invalid JSON: shown as raw payload, never crashes the loop.
- Socket / OS errors during receive: logged to the console, loop continues
  where sensible; fatal bind errors exit with a clear message.
- Ctrl-C: graceful teardown.

## Usage

```bash
python listener.py                      # 239.10.10.10:5005
python listener.py 239.10.10.10 5005    # positional
python listener.py --group 239.10.10.10 --port 5005

# In another terminal, to test:
python sender.py                        # sends sample JSON to the default group
```

## Testing

Manual verification on macOS: run `listener.py`, then run `sender.py` in a
second terminal and confirm the JSON renders as a formatted panel; send a
non-JSON payload and confirm it appears in the raw/red panel.
