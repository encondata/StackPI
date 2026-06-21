#!/usr/bin/env python3
"""Send sample multicast messages for testing listener.py.

    python sender.py                      # send sample JSON to 239.10.10.10:5005
    python sender.py 239.10.10.10 5005    # positional
    python sender.py --count 5 --interval 0.5
    python sender.py --raw "not json"     # send a non-JSON payload
"""

import argparse
import json
import socket
import struct
import time
from datetime import datetime

DEFAULT_GROUP = "239.10.10.10"
DEFAULT_PORT = 5005


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Send test multicast messages.")
    parser.add_argument("group", nargs="?", default=DEFAULT_GROUP)
    parser.add_argument("port", nargs="?", type=int, default=DEFAULT_PORT)
    parser.add_argument("--count", type=int, default=3, help="messages to send")
    parser.add_argument(
        "--interval", type=float, default=1.0, help="seconds between messages"
    )
    parser.add_argument(
        "--raw", default=None, help="send this literal (non-JSON) string instead"
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    # TTL=1 keeps traffic on the local network segment.
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, struct.pack("b", 1))

    dest = (args.group, args.port)
    try:
        for i in range(1, args.count + 1):
            if args.raw is not None:
                payload = args.raw.encode("utf-8")
            else:
                payload = json.dumps(
                    {
                        "seq": i,
                        "epc": f"E280-1160-6000-{i:04d}",
                        "antenna": (i % 4) + 1,
                        "rssi": -42 - i,
                        "timestamp": datetime.now().isoformat(),
                    }
                ).encode("utf-8")
            sock.sendto(payload, dest)
            print(f"sent {i}/{args.count} -> {args.group}:{args.port}")
            if i < args.count:
                time.sleep(args.interval)
    finally:
        sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
