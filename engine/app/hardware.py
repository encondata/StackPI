"""Pi hardware identification.

`hardware_serial` is the value the BaseCamp API uses to re-discover a Pi
after a re-flash (when device_uuid is lost). On Raspberry Pi OS it lives
in /proc/cpuinfo as the `Serial` field. Returns None on non-Pi hosts so
local dev on macOS still works.
"""
from pathlib import Path
from typing import Optional


def get_hardware_serial() -> Optional[str]:
    cpuinfo = Path("/proc/cpuinfo")
    if not cpuinfo.exists():
        return None
    try:
        for line in cpuinfo.read_text().splitlines():
            if line.startswith("Serial"):
                _, _, value = line.partition(":")
                value = value.strip()
                if value and value != "0000000000000000":
                    return value
    except OSError:
        return None
    return None
