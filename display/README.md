# display

The **StackPI remote status display** — a slim Raspberry Pi (Pi 3+ class) on a
monitor that shows the `/status` and `/trucks` screens, fed by the primary
StackPI over UDP multicast. No Postgres, no FastAPI, no portal build on the
device: it just listens for status snapshots and renders them.

Status (this folder so far): **protocol spec only.** The device itself
(receiver + kiosk + minimal Wi-Fi/multicast config + bootstrap) is the next
sub-project.

- **[status-protocol.md](status-protocol.md)** — the wire spec the primary
  *sends* (`api/app/status_broadcast.py`) and the display *receives*.

## Architecture (planned)

```
primary StackPI ──UDP multicast (status snapshot, 5s + on-change)──▶
   remote Pi:  receiver daemon → localhost (SSE/file) → kiosk browser
               showing static-exported /status + /trucks
```
The browser can't read raw multicast, so a tiny local receiver bridges the
snapshot to the page.
