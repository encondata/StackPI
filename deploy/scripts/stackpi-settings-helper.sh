#!/usr/bin/env bash
# StackPI privileged settings helper.
#
# Runs as root via a tightly-scoped sudoers entry (csg can only invoke
# THIS script with NOPASSWD; csg cannot modify the script because it's
# in /usr/local/sbin which is root-owned).
#
# Validates inputs before passing them to system tools so a compromised
# API can't escape into arbitrary command execution.
#
# Usage:
#   stackpi-settings-helper.sh get-hostname
#   stackpi-settings-helper.sh set-hostname <name>
#   stackpi-settings-helper.sh get-active-connections
#   stackpi-settings-helper.sh list-wifi
#   stackpi-settings-helper.sh connect-wifi <ssid> <password>
#   stackpi-settings-helper.sh reboot

set -euo pipefail

cmd="${1:-}"
shift || true

fail() { echo "stackpi-settings-helper: $1" >&2; exit 2; }

# Hostname: RFC 1123 lower-case label, 1..63 chars, no leading/trailing dash.
valid_hostname() {
  local h="$1"
  [[ ${#h} -ge 1 && ${#h} -le 63 ]] || return 1
  [[ "$h" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  return 0
}

# Dotted-quad IPv4 check. The API already validates, but this helper runs as
# root, so it re-validates every value that reaches nmcli (same posture as the
# prefix check below) — defense in depth, and safe if called by anything else.
valid_ipv4() {
  local a="$1" o
  [[ "$a" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  local IFS=.
  for o in $a; do
    [[ "$o" -le 255 ]] || return 1
  done
  return 0
}

# Resolve the wired connection/device dynamically (never hardcode eth0).
_wired_conn() {
  nmcli -t -f NAME,TYPE connection show \
    | awk -F: '$2=="802-3-ethernet"{print $1; exit}'
}
_wired_dev() {
  nmcli -t -f DEVICE,TYPE device status \
    | awk -F: '$2=="ethernet"{print $1; exit}'
}

case "$cmd" in
  get-hostname)
    hostnamectl --static
    ;;

  set-hostname)
    new="${1:-}"
    [[ -n "$new" ]] || fail "missing hostname"
    valid_hostname "$new" || fail "invalid hostname (must match RFC 1123 lowercase label)"

    old="$(hostnamectl --static)"
    hostnamectl set-hostname "$new"

    # Keep /etc/hosts in sync so sudo lookups don't slow down.
    if grep -qE "^[[:space:]]*127\.0\.1\.1[[:space:]]" /etc/hosts; then
      sed -i "s|^[[:space:]]*127\.0\.1\.1[[:space:]].*|127.0.1.1\t$new|" /etc/hosts
    else
      printf '127.0.1.1\t%s\n' "$new" >> /etc/hosts
    fi
    echo "set-hostname: $old -> $new"
    ;;

  get-active-connections)
    # Tab-separated columns: NAME, TYPE, DEVICE, STATE
    nmcli -t -f NAME,TYPE,DEVICE,STATE connection show --active
    ;;

  list-wifi)
    # Force a rescan so the UI sees fresh signal levels.
    # Returns: IN-USE:SSID:SIGNAL:SECURITY (colon-separated, nmcli -t).
    nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list --rescan auto
    ;;

  connect-wifi)
    ssid="${1:-}"
    password="${2:-}"
    hidden="${3:-no}"
    [[ -n "$ssid" ]] || fail "missing ssid"
    [[ ${#ssid} -le 32 ]] || fail "ssid too long"
    [[ ${#password} -le 128 ]] || fail "password too long"

    # Remove any stale connection profile (NM saves incomplete profiles
    # that fail with "key-mgmt missing" or "secrets required").
    nmcli connection delete "$ssid" >/dev/null 2>&1 || true

    # Force a fresh scan so NM knows the AP's actual security type. Without
    # this, a stale cache leads to "Secrets were required, but not provided"
    # because NM falls back to an existing profile with no PSK.
    nmcli device wifi list --rescan yes >/dev/null 2>&1 || true

    nm_args=(device wifi connect "$ssid")
    [[ -n "$password" ]] && nm_args+=(password "$password")
    [[ "$hidden" == "yes" ]] && nm_args+=(hidden yes)
    nmcli "${nm_args[@]}"
    ;;

  disconnect-wifi)
    ssid="${1:-}"
    [[ -n "$ssid" ]] || fail "missing ssid"
    [[ ${#ssid} -le 32 ]] || fail "ssid too long"
    # Find the *active* connection name matching this SSID. nmcli's wifi
    # connect names the profile after the SSID, but be defensive in case
    # of duplicates / renamed profiles.
    conn=$(nmcli -t -f NAME,TYPE connection show --active \
      | awk -F: -v s="$ssid" '$2=="802-11-wireless" && $1==s {print $1; exit}')
    if [[ -z "$conn" ]]; then
      fail "not currently connected to $ssid"
    fi
    nmcli connection down "$conn"
    ;;

  reboot)
    # Delay so an HTTP response can complete before the box goes down.
    nohup bash -c 'sleep 5 && /sbin/shutdown -r now' </dev/null >/dev/null 2>&1 &
    echo "reboot scheduled in 5s"
    ;;

  get-timezone)
    timedatectl show -p Timezone --value
    ;;

  set-timezone)
    new="${1:-}"
    [[ -n "$new" ]] || fail "missing timezone"
    # Basic shape — no nulls/newlines, reasonable length.
    [[ ${#new} -le 60 ]] || fail "timezone name too long"
    [[ "$new" =~ ^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$ ]] \
      || fail "invalid timezone format"
    # Final check against the canonical list — exact match.
    timedatectl list-timezones | grep -qFx "$new" \
      || fail "unknown timezone: $new"
    timedatectl set-timezone "$new"
    echo "set-timezone: $new"
    ;;

  get-time-status)
    # Multi-line key=value; the API parses each line.
    printf 'timezone=%s\n' "$(timedatectl show -p Timezone --value)"
    printf 'ntp_active=%s\n' "$(timedatectl show -p NTP --value)"
    printf 'synchronized=%s\n' \
      "$(timedatectl show -p NTPSynchronized --value)"
    printf 'local_time=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf 'utc_time=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    server=$(timedatectl show-timesync 2>/dev/null \
      | awk -F= '/^ServerName=/{print $2; exit}')
    printf 'current_server=%s\n' "$server"
    ;;

  get-ntp-servers)
    # Our drop-in if it exists, otherwise nothing — fall back to defaults.
    if [[ -f /etc/systemd/timesyncd.conf.d/stackpi.conf ]]; then
      awk -F= '/^NTP=/{print $2; exit}' \
        /etc/systemd/timesyncd.conf.d/stackpi.conf
    fi
    ;;

  set-ntp-servers)
    # Remaining args = list of server hostnames/IPs. Zero args clears the
    # drop-in (falls back to Debian pool defaults).
    DROPIN_DIR=/etc/systemd/timesyncd.conf.d
    DROPIN=$DROPIN_DIR/stackpi.conf
    if [[ $# -eq 0 ]]; then
      rm -f "$DROPIN"
      systemctl restart systemd-timesyncd
      echo "ntp: cleared override, using defaults"
      exit 0
    fi
    for s in "$@"; do
      [[ ${#s} -le 253 ]] || fail "server too long: $s"
      [[ "$s" =~ ^[A-Za-z0-9.:_-]+$ ]] || fail "invalid server name: $s"
    done
    mkdir -p "$DROPIN_DIR"
    # Strip any prior file in place — we own this drop-in entirely.
    {
      printf '[Time]\n'
      printf 'NTP=%s\n' "$*"
    } > "$DROPIN"
    chmod 0644 "$DROPIN"
    systemctl restart systemd-timesyncd
    echo "ntp: set to $*"
    ;;

  get-wired)
    # Parseable key=value lines describing the wired connection. Defensive:
    # if there's no wired connection, emit empty connection/device and exit 0.
    conn="$(_wired_conn)"
    dev="$(_wired_dev)"
    printf 'connection=%s\n' "$conn"
    printf 'device=%s\n' "$dev"

    carrier=0
    if [[ -n "$dev" ]]; then
      state=$(nmcli -t -f DEVICE,STATE device status \
        | awk -F: -v d="$dev" '$1==d{print $2; exit}')
      [[ "$state" == "connected" ]] && carrier=1
    fi
    printf 'carrier=%s\n' "$carrier"

    if [[ -z "$conn" ]]; then
      printf 'method=auto\n'
      printf 'addresses=\n'
      printf 'gateway=\n'
      printf 'dns=\n'
      exit 0
    fi

    method=$(nmcli -t -f ipv4.method connection show "$conn" 2>/dev/null \
      | awk -F: '{print $2; exit}')
    [[ -n "$method" ]] || method=auto
    printf 'method=%s\n' "$method"

    # Prefer the live IP4.ADDRESS if the connection is active; else the
    # configured ipv4.addresses.
    addresses=$(nmcli -t -f IP4.ADDRESS connection show "$conn" 2>/dev/null \
      | awk -F: 'NR==1{sub(/^[^:]*:/,""); print; exit}')
    if [[ -z "$addresses" ]]; then
      addresses=$(nmcli -t -f ipv4.addresses connection show "$conn" 2>/dev/null \
        | awk -F: '{print $2; exit}')
    fi
    printf 'addresses=%s\n' "$addresses"

    gateway=$(nmcli -t -f IP4.GATEWAY connection show "$conn" 2>/dev/null \
      | awk -F: '{print $2; exit}')
    if [[ -z "$gateway" ]]; then
      gateway=$(nmcli -t -f ipv4.gateway connection show "$conn" 2>/dev/null \
        | awk -F: '{print $2; exit}')
    fi
    printf 'gateway=%s\n' "$gateway"

    dns=$(nmcli -t -f ipv4.dns connection show "$conn" 2>/dev/null \
      | awk -F: '{print $2; exit}')
    printf 'dns=%s\n' "$dns"
    ;;

  set-wired-dhcp)
    conn="$(_wired_conn)"
    [[ -n "$conn" ]] || fail "no wired connection found"
    # Clear static fields so the switch back to DHCP is clean.
    nmcli connection modify "$conn" ipv4.method auto ipv4.gateway "" ipv4.dns "" ipv4.addresses ""
    nmcli connection up "$conn"
    ;;

  set-wired-static)
    ip="${1:-}"
    prefix="${2:-}"
    gw="${3:-}"
    dns="${4:-}"
    conn="$(_wired_conn)"
    [[ -n "$conn" ]] || fail "no wired connection found"
    [[ -n "$ip" ]] || fail "missing ip"
    [[ -n "$prefix" ]] || fail "missing prefix"
    [[ -n "$gw" ]] || fail "missing gateway"
    [[ "$prefix" =~ ^[0-9]+$ ]] || fail "invalid prefix"
    [[ "$prefix" -ge 1 && "$prefix" -le 32 ]] || fail "prefix out of range (1-32)"
    valid_ipv4 "$ip" || fail "invalid ip"
    valid_ipv4 "$gw" || fail "invalid gateway"
    # dns is a comma-separated list (may be empty); every entry must be IPv4.
    if [[ -n "$dns" ]]; then
      IFS=',' read -ra _dns <<< "$dns"
      for _d in "${_dns[@]}"; do
        valid_ipv4 "$_d" || fail "invalid dns: $_d"
      done
    fi
    nmcli connection modify "$conn" ipv4.method manual \
      ipv4.addresses "$ip/$prefix" ipv4.gateway "$gw" ipv4.dns "$dns"
    nmcli connection up "$conn"
    ;;

  "")
    fail "no subcommand given"
    ;;

  *)
    fail "unknown subcommand: $cmd"
    ;;
esac
