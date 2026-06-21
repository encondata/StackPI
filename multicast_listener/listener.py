#!/usr/bin/env python3
"""Listen for multicast JSON messages and pretty-print them with rich.

Runs until interrupted (Ctrl-C). The multicast group and port may be supplied
as command-line arguments; otherwise the DEFAULT_* values below are used.

    python listener.py                      # 239.10.10.10:5005
    python listener.py 239.10.10.10 5005    # positional
    python listener.py --group 239.10.10.10 --port 5005
"""

import argparse
import json
import socket
import struct
import sys
from datetime import datetime

from rich.console import Console
from rich.json import JSON
from rich.panel import Panel
from rich.text import Text

DEFAULT_GROUP = "239.10.10.10"
DEFAULT_PORT = 5005

console = Console()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Listen for multicast JSON messages and pretty-print them."
    )
    parser.add_argument(
        "group",
        nargs="?",
        default=DEFAULT_GROUP,
        help=f"Multicast group IP (default: {DEFAULT_GROUP})",
    )
    parser.add_argument(
        "port",
        nargs="?",
        type=int,
        default=DEFAULT_PORT,
        help=f"UDP port (default: {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--group",
        dest="group_opt",
        default=None,
        help="Multicast group IP (overrides positional)",
    )
    parser.add_argument(
        "--port",
        dest="port_opt",
        type=int,
        default=None,
        help="UDP port (overrides positional)",
    )
    args = parser.parse_args(argv)
    # Flags take precedence over positionals when both are given.
    group = args.group_opt if args.group_opt is not None else args.group
    port = args.port_opt if args.port_opt is not None else args.port
    return group, port


def make_socket(group, port):
    """Create a UDP socket bound to the port and joined to the multicast group."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # SO_REUSEPORT lets multiple listeners share the port (common for multicast
    # on macOS/BSD) and avoids spurious "address already in use" errors.
    if hasattr(socket, "SO_REUSEPORT"):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    # Bind to all interfaces on the given port so the group's traffic arrives.
    sock.bind(("", port))
    # Join the multicast group on the default interface.
    mreq = struct.pack("4sl", socket.inet_aton(group), socket.INADDR_ANY)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    return sock, mreq


def render(payload, addr):
    """Print one received payload as a rich panel."""
    host, port = addr
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    source = f"{host}:{port}"
    try:
        # Validate/normalize, then hand the text to rich's JSON highlighter.
        parsed = json.loads(payload)
        body = JSON(json.dumps(parsed))
        title = Text(f"JSON  •  {source}", style="bold cyan")
        console.print(
            Panel(body, title=title, subtitle=timestamp, border_style="cyan")
        )
    except json.JSONDecodeError:
        body = Text(payload, style="white")
        title = Text(f"RAW (not JSON)  •  {source}", style="bold red")
        console.print(
            Panel(body, title=title, subtitle=timestamp, border_style="red")
        )


def main(argv=None):
    group, port = parse_args(argv)

    try:
        sock, mreq = make_socket(group, port)
    except OSError as exc:
        console.print(f"[bold red]Failed to open socket:[/] {exc}")
        return 1

    console.print(
        f"[bold green]Listening[/] on multicast [cyan]{group}:{port}[/]  "
        f"(Ctrl-C to stop)"
    )

    try:
        while True:
            try:
                data, addr = sock.recvfrom(65535)
            except OSError as exc:
                console.print(f"[yellow]Receive error:[/] {exc}")
                continue
            payload = data.decode("utf-8", errors="replace")
            render(payload, addr)
    except KeyboardInterrupt:
        console.print("\n[bold]Stopping…[/]")
    finally:
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_DROP_MEMBERSHIP, mreq)
        except OSError:
            pass
        sock.close()
        console.print("[green]Socket closed. Bye.[/]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
