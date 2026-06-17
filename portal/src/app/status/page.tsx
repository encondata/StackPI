"use client";

import { useEffect, useRef, useState } from "react";
import { useRevocationGuard } from "@/hooks/useRevocationGuard";
import { FlashAlertOverlay } from "@/components/FlashAlertOverlay";
import {
  ChangeBorder,
  changeBorderDurationMs,
  toChangeBorderStyle,
  type ChangeBorderStyle,
} from "@/components/ChangeBorder";
import { friendlyTimezone } from "@/lib/timezone";

type Connection = {
  type?: string;
  device?: string;
  ip4?: string;
};

type SettingsLite = {
  hostname?: string;
  wan_ip?: string | null;
  connections?: Connection[];
  uptime_seconds?: number | null;
  timezone?: string | null;
};

// friendlyTimezone + its IANA lookup table live in @/lib/timezone (shared
// with the /trucks status bar via KioskStatusBar).

// Cards on the top row. Backed by GET /local/metrics on a 5s poll. Any
// field left undefined renders the card as "—".
type Metrics = {
  tags_today?: number;
  unique_tags_today?: number;
  readers_up?: number;
  readers_total?: number;
  assets_total?: number;
  assets_matched?: number;
  pending_sync?: number;
  last_sync?: string;
  errors_24h?: number;
};

const METRICS_REFRESH_MS = 5000;

function metric(value: number | string | undefined | null): string {
  if (value == null) return "—";
  return typeof value === "number" ? value.toLocaleString() : value;
}

// "Last Sync" card formatting. Returns null when the input isn't a usable
// timestamp so the card falls back to the standard "—" placeholder.
const MONTH_ABBREV = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function formatLastSync(
  raw: string | number | null | undefined,
): { time: string; date: string } | null {
  if (raw == null) return null;
  // Normalize Postgres-style timestamp strings into ISO 8601:
  //   * Space between date and time → "T"
  //   * Truncated TZ "-05" (or "+10") → "-05:00" / "+10:00". new Date()
  //     rejects the single-hour form, so we have to pad it ourselves.
  let candidate = typeof raw === "string" ? raw : String(raw);
  candidate = candidate.replace(" ", "T");
  candidate = candidate.replace(/([+-])(\d{2})$/, "$1$2:00");
  const d = new Date(candidate);
  if (!Number.isFinite(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const mon = MONTH_ABBREV[d.getMonth()];
  const yyyy = d.getFullYear();
  return { time: `${hh}:${mm}`, date: `${dd}-${mon}-${yyyy}` };
}

// --- RFID Activity stream + auto-clear -----------------------------------
//
// The activity panel renders a unified list of "activity entries", keyed
// by scan_id. Entries arrive from two SSE sources:
//   * /local/rfid/rfid/matches/stream — always subscribed; emits resolved
//     hits via app.rfid_scan_processing.
//   * /local/rfid/scans/stream — only subscribed when the operator has
//     enabled "show unmatched scans" (rfid_show_unmatched_scans). Used
//     to surface raw reads that didn't match any source table.
// When both streams report the same scan_id the matched record wins,
// regardless of which one arrived first — match info is strictly more
// informative.

type MatchData = {
  name?: string;
  asset_serial_number?: string | null;
  asset_make?: string | null;
  asset_model?: string | null;
};
type MatchEvent = {
  id: number;             // scan_id (dedup key, shared with scans stream)
  match_id: number;
  reader_name: string;
  event_timestamp: string | null;
  match_type: string;
  match_data: MatchData;
};
type RawScanEvent = {
  id: number;
  id_hex: string;
  reader_name: string;
  event_timestamp: string | null;
};
type ActivityEntry = {
  id: number;                  // scan_id
  reader_name: string;
  event_timestamp: string | null;
  matched: boolean;
  // Populated when matched
  match_type?: string;
  match_data?: MatchData;
  // Populated when unmatched (toggle on)
  id_hex?: string;
};
const ACTIVITY_MAX_BUFFERED = 500;
// Settings poll: 3s so the chase-test trigger surfaces with at most ~3s
// latency between the operator clicking Test and the kiosk reacting. The
// payload is small and the endpoint is cheap.
const SETTINGS_REFRESH_MS = 3_000;
const SCREEN_STATUS_FALLBACK_AUTO_CLEAR_MIN = 15;
// 8 cards in the row + 600ms stagger keeps the sequence under ~5.4s.
const STATUS_CARD_COUNT = 8;
const STATUS_CHASE_STAGGER_MS = 600;

type SystemEvent = {
  id: number;
  timestamp: string;
  message: string;
};
const SYSTEM_EVENTS_MAX_BUFFERED = 200;

function trimIdHex(s: string | null | undefined): string {
  if (!s) return "";
  const stripped = s.replace(/^0+/, "") || "0";
  return stripped.length > 10 ? stripped.slice(-10) : stripped;
}

function formatScanTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false });
  } catch {
    return "—";
  }
}

// Operator-facing registration display is driven by the API's
// `display_status` (registered | offline | unregistered). "unknown" is a
// local fallback used before the first poll resolves / on fetch failure.
type RegStatus = "registered" | "offline" | "unregistered" | "unknown";

const REG_DISPLAY: Record<RegStatus, { label: string; tone: string }> = {
  registered:   { label: "Registered",    tone: "text-green-400" },
  offline:      { label: "Offline",       tone: "text-amber-400" },
  unregistered: { label: "Un-Registered", tone: "text-zinc-400" },
  unknown:      { label: "Unknown",       tone: "text-zinc-400" },
};

function formatUptime(s: number | null | undefined): string {
  if (s == null || s < 0) return "—";
  if (s < 60) return `${Math.floor(s)}s`;
  const totalMin = Math.floor(s / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const mRem = totalMin % 60;
  if (totalHr < 24) return `${totalHr}h ${mRem}m`;
  const d = Math.floor(totalHr / 24);
  const hRem = totalHr % 24;
  return `${d}d ${hRem}h`;
}

export default function StatusPage() {
  useRevocationGuard();
  const [hostname, setHostname] = useState<string>("…");
  const [ip, setIp] = useState<string>("");
  const [wanIp, setWanIp] = useState<string>("");
  const [timezone, setTimezone] = useState<string>("");
  const [time, setTime] = useState<string>("");
  const [dateStr, setDateStr] = useState<string>("");
  const [uptimeBase, setUptimeBase] = useState<{
    seconds: number;
    atMs: number;
  } | null>(null);
  const [uptimeNow, setUptimeNow] = useState<number | null>(null);
  const [reg, setReg] = useState<RegStatus>("unknown");
  const [metrics, setMetrics] = useState<Metrics>({});
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [showUnmatched, setShowUnmatched] = useState<boolean>(false);
  const [systemEvents, setSystemEvents] = useState<SystemEvent[]>([]);
  const [autoClearMinutes, setAutoClearMinutes] = useState<number>(
    SCREEN_STATUS_FALLBACK_AUTO_CLEAR_MIN,
  );
  // Mirror of autoClearMinutes accessible inside the SSE onmessage handler
  // (the EventSource effect runs once on mount and would otherwise
  // capture the initial value). Updated whenever the setting changes so
  // the filter window tracks the latest configured interval.
  const autoClearMinutesRef = useRef<number>(autoClearMinutes);
  useEffect(() => {
    autoClearMinutesRef.current = autoClearMinutes;
  }, [autoClearMinutes]);
  const [changeBorderWidthPx, setChangeBorderWidthPx] = useState<number>(10);
  const [changeBorderColor, setChangeBorderColor] = useState<string>(
    "#22c55e",
  );
  const [changeBorderCycleCount, setChangeBorderCycleCount] =
    useState<number>(2);
  const [changeBorderStyle, setChangeBorderStyle] =
    useState<ChangeBorderStyle>("comet");
  // Per-card "force fire" counter. Incrementing slot i triggers a one-shot
  // chase on metric card i. Sequenced from the chase-test handler below.
  const [cardForceFire, setCardForceFire] = useState<number[]>(() =>
    Array(STATUS_CARD_COUNT).fill(0),
  );
  // Last-known chase-test trigger timestamp. We don't fire on the very
  // first poll (initial state); we fire when the value CHANGES.
  const lastChaseTriggerRef = useRef<number | null>(null);
  const chaseTimersRef = useRef<number[]>([]);
  useEffect(() => {
    return () => {
      for (const id of chaseTimersRef.current) window.clearTimeout(id);
      chaseTimersRef.current = [];
    };
  }, []);

  function runChaseSequence() {
    for (const id of chaseTimersRef.current) window.clearTimeout(id);
    chaseTimersRef.current = [];
    setCardForceFire((prev) => {
      const next = [...prev];
      next[0] = next[0] + 1;
      return next;
    });
    for (let i = 1; i < STATUS_CARD_COUNT; i++) {
      const id = window.setTimeout(() => {
        setCardForceFire((prev) => {
          const next = [...prev];
          next[i] = next[i] + 1;
          return next;
        });
      }, i * STATUS_CHASE_STAGGER_MS);
      chaseTimersRef.current.push(id);
    }
  }
  // We keep a ref to activity so the auto-clear interval can read the
  // latest length without having to re-create the interval each time the
  // list changes.
  const activityRef = useRef<ActivityEntry[]>([]);
  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);
  // Previous radioActivity per reader_id, used by the reader-state effect
  // to detect transitions. Stays in a ref so updates don't re-run the
  // polling effect; only the polled snapshot drives state changes.
  const prevReaderReadingRef = useRef<Record<number, boolean>>({});
  // Aggregated RFID subsystem traffic-light state.
  // Rules (worst-state across all enabled readers):
  //   * Red  : any reader has last_error set OR has no usable status yet.
  //   * Yellow: every reader is reachable but at least one has a non-
  //             connected entry in last_status.interfaceConnectionStatus.data.
  //   * Blue : every reader has all connectors connected.
  //   * Green: AT LEAST ONE reader has radioActivity === "active".
  // Only blue and green can co-light; red and yellow are exclusive.
  const [lightState, setLightState] = useState<{
    red: boolean;
    yellow: boolean;
    blue: boolean;
    green: boolean;
  }>({ red: false, yellow: false, blue: false, green: false });

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(
        d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
      setDateStr(
        d.toLocaleDateString([], {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/status", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as {
            status?: string;
            display_status?: string;
          };
          const ds = d?.display_status;
          if (
            ds === "registered" ||
            ds === "offline" ||
            ds === "unregistered"
          ) {
            setReg(ds);
          } else {
            // Fall back to deriving from `status` if `display_status` is
            // absent: registered → "registered", everything else (revoked /
            // pre_registered / unknown) → "unregistered".
            setReg(d?.status === "registered" ? "registered" : "unregistered");
          }
        }
      } catch {
        /* keep last value */
      }
    }
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch("/local/metrics", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as Metrics;
          setMetrics(d);
        }
      } catch {
        /* keep last value */
      }
    }
    tick();
    const id = setInterval(tick, METRICS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Poll the screen-status setting periodically so a saved change on
  // /config/settings/screen-status takes effect without a page refresh.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/settings/screen-status", {
          cache: "no-store",
        });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as {
            auto_clear_minutes?: number;
            change_border_width_px?: number;
            change_border_color?: string;
            change_border_cycle_count?: number;
            change_border_style?: string;
            chase_test_triggered_at?: number;
          };
          if (typeof d.auto_clear_minutes === "number") {
            setAutoClearMinutes(d.auto_clear_minutes);
          }
          if (typeof d.change_border_width_px === "number") {
            setChangeBorderWidthPx(d.change_border_width_px);
          }
          if (typeof d.change_border_color === "string") {
            setChangeBorderColor(d.change_border_color);
          }
          if (typeof d.change_border_cycle_count === "number") {
            setChangeBorderCycleCount(d.change_border_cycle_count);
          }
          if (typeof d.change_border_style === "string") {
            setChangeBorderStyle(toChangeBorderStyle(d.change_border_style));
          }
          // Chase test: fire the sequence when the trigger value changes.
          // The very first poll just captures the baseline so a fresh
          // page load doesn't trigger an animation against a stale value.
          if (typeof d.chase_test_triggered_at === "number") {
            const seen = lastChaseTriggerRef.current;
            const incoming = d.chase_test_triggered_at;
            if (seen !== null && incoming !== seen && incoming > 0) {
              runChaseSequence();
            }
            lastChaseTriggerRef.current = incoming;
          }
        }
      } catch {
        /* keep last */
      }
    }
    load();
    const id = setInterval(load, SETTINGS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Detect reader radio-state transitions on a 5s poll and append a
  // System Events entry on every change. The first poll establishes the
  // baseline silently (no entries emitted) so reloading the page doesn't
  // produce a flurry of "started reading" entries reflecting state we
  // already knew about. Only true state changes between two polls fire.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/local/rfid/readers", { cache: "no-store" });
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as {
          readers?: Array<{
            id: number;
            name: string;
            enabled?: boolean;
            last_error?: string | null;
            last_status?: {
              radioActivity?: string;
              radioActivitiy?: string;
              interfaceConnectionStatus?: {
                data?: Array<{ connectionStatus?: string }>;
              };
            } | null;
          }>;
        };
        const snap: Record<number, boolean> = {};
        const fresh: SystemEvent[] = [];
        const prevMap = prevReaderReadingRef.current;
        const haveBaseline = Object.keys(prevMap).length > 0;
        const now = new Date();

        // Aggregate the traffic-light state across all enabled readers
        // while we walk them, so we don't iterate twice.
        let anyRed = false;
        let anyYellow = false;
        let anyReading = false;
        let enabledCount = 0;

        for (const r of body.readers ?? []) {
          if (r.enabled === false) continue;
          enabledCount += 1;

          const activity =
            r.last_status?.radioActivity ?? r.last_status?.radioActivitiy;
          const reading = String(activity ?? "").toLowerCase() === "active";
          snap[r.id] = reading;
          if (reading) anyReading = true;

          if (haveBaseline && prevMap[r.id] !== undefined && prevMap[r.id] !== reading) {
            fresh.push({
              id: now.getTime() + r.id,
              timestamp: now.toISOString(),
              message: `Reader ${r.name} ${reading ? "started" : "stopped"} reading`,
            });
          }

          // Red if there's any error, or we have no status at all yet.
          if (r.last_error || !r.last_status) {
            anyRed = true;
            continue;
          }
          // Yellow if any outbound connector is non-connected (or the list
          // is empty — we can't confirm ziotc connectivity).
          const interfaces =
            r.last_status.interfaceConnectionStatus?.data ?? [];
          const allConnected =
            interfaces.length > 0 &&
            interfaces.every(
              (i) =>
                String(i?.connectionStatus ?? "").toLowerCase() === "connected",
            );
          if (!allConnected) anyYellow = true;
        }
        prevReaderReadingRef.current = snap;

        // If no enabled readers, light is all-off (nothing to report on).
        if (enabledCount === 0) {
          setLightState({ red: false, yellow: false, blue: false, green: false });
        } else if (anyRed) {
          setLightState({ red: true, yellow: false, blue: false, green: false });
        } else if (anyYellow) {
          setLightState({ red: false, yellow: true, blue: false, green: false });
        } else {
          // All enabled readers reachable + all connectors connected.
          // Blue is on; green stacks on top if any reader is actively
          // reading.
          setLightState({
            red: false,
            yellow: false,
            blue: true,
            green: anyReading,
          });
        }
        if (fresh.length > 0) {
          setSystemEvents((prev) => {
            const next = [...fresh.reverse(), ...prev];
            return next.length > SYSTEM_EVENTS_MAX_BUFFERED
              ? next.slice(0, SYSTEM_EVENTS_MAX_BUFFERED)
              : next;
          });
        }
      } catch {
        /* keep last */
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // SSE: server-side system events (sync results, future engine emissions,
  // etc.) emitted via app.system_events.emit(...). Each event prepends to
  // the existing systemEvents array; we use a negative id derived from the
  // server-side row id so client-side timer ids never collide.
  useEffect(() => {
    const es = new EventSource("/local/system-events/stream");
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data) as {
          id: number;
          emitted_at: string | null;
          source: string;
          kind: string;
          message: string;
          detail: string | null;
        };
        const ts =
          (d.emitted_at && new Date(d.emitted_at).toISOString()) ||
          new Date().toISOString();
        const stableId = -d.id;
        setSystemEvents((prev) => {
          if (prev.some((e) => e.id === stableId)) return prev;
          const next: SystemEvent[] = [
            { id: stableId, timestamp: ts, message: d.message },
            ...prev,
          ];
          return next.length > SYSTEM_EVENTS_MAX_BUFFERED
            ? next.slice(0, SYSTEM_EVENTS_MAX_BUFFERED)
            : next;
        });
      } catch {
        /* malformed frame */
      }
    };
    return () => es.close();
  }, []);

  // Drop entries older than the auto-clear window. Used by both SSE
  // subscribers to suppress stale backlog events on page reload (so a
  // refresh doesn't repopulate activity an in-progress auto-clear would
  // have removed).
  function isWithinAutoClearWindow(eventTimestamp: string | null): boolean {
    if (!eventTimestamp) return true;
    const ageMs = Date.now() - new Date(eventTimestamp).getTime();
    if (!Number.isFinite(ageMs)) return true;
    const windowMs = Math.max(1, autoClearMinutesRef.current) * 60_000;
    return ageMs <= windowMs;
  }

  // SSE: stream new local_rfid_matches rows. Always subscribed — matched
  // hits are what the kiosk page primarily wants to display.
  useEffect(() => {
    const es = new EventSource("/local/rfid/matches/stream");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as MatchEvent;
        if (!isWithinAutoClearWindow(data.event_timestamp)) return;
        setActivity((prev) => {
          // If an unmatched entry for this scan_id is already present,
          // upgrade it in place (preserve position so the list doesn't
          // visually jump). Otherwise prepend a new matched entry.
          const idx = prev.findIndex((e) => e.id === data.id);
          const upgraded: ActivityEntry = {
            id:              data.id,
            reader_name:     data.reader_name,
            event_timestamp: data.event_timestamp,
            matched:         true,
            match_type:      data.match_type,
            match_data:      data.match_data ?? {},
          };
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = upgraded;
            return next;
          }
          const next = [upgraded, ...prev];
          return next.length > ACTIVITY_MAX_BUFFERED
            ? next.slice(0, ACTIVITY_MAX_BUFFERED)
            : next;
        });
      } catch {
        /* malformed frame */
      }
    };
    return () => es.close();
  }, []);

  // Conditional SSE: when the operator has enabled "show unmatched scans",
  // tail the raw-scan stream too so reads with no source match still
  // surface on the kiosk. Disabled by default — the matches stream alone
  // is enough for normal kiosk use.
  useEffect(() => {
    if (!showUnmatched) return;
    const es = new EventSource("/local/rfid/scans/stream");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as RawScanEvent;
        if (!isWithinAutoClearWindow(data.event_timestamp)) return;
        setActivity((prev) => {
          // Don't downgrade a matched entry. If we've already shown the
          // scan_id (either matched or unmatched), leave it alone.
          if (prev.some((e) => e.id === data.id)) return prev;
          const entry: ActivityEntry = {
            id:              data.id,
            reader_name:     data.reader_name,
            event_timestamp: data.event_timestamp,
            matched:         false,
            id_hex:          data.id_hex,
          };
          const next = [entry, ...prev];
          return next.length > ACTIVITY_MAX_BUFFERED
            ? next.slice(0, ACTIVITY_MAX_BUFFERED)
            : next;
        });
      } catch {
        /* malformed frame */
      }
    };
    return () => es.close();
  }, [showUnmatched]);

  // When the operator flips the toggle off mid-session, strip out any
  // unmatched entries already on the list so the view immediately reflects
  // the current setting.
  useEffect(() => {
    if (showUnmatched) return;
    setActivity((prev) => prev.filter((e) => e.matched));
  }, [showUnmatched]);

  // Poll the RFID settings endpoint for the show-unmatched toggle. Short
  // interval so a save on /config/rfid/settings takes effect within ~3s
  // without a manual page refresh.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch("/local/rfid/settings", { cache: "no-store" });
        if (cancelled || !r.ok) return;
        const d = (await r.json()) as {
          rfid_show_unmatched_scans?: boolean;
        };
        if (typeof d.rfid_show_unmatched_scans === "boolean") {
          setShowUnmatched(d.rfid_show_unmatched_scans);
        }
      } catch {
        /* keep last */
      }
    }
    tick();
    const id = window.setInterval(tick, SETTINGS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Auto-clear: every autoClearMinutes, drop the visible RFID Activity
  // list and log "RFID Activity Cleared" to System Events. Setting changes
  // take effect on the next interval tick because the effect re-runs when
  // autoClearMinutes changes (the cleanup clears the prior interval).
  useEffect(() => {
    const ms = Math.max(1, autoClearMinutes) * 60_000;
    const id = window.setInterval(() => {
      const now = new Date();
      const hadEntries = activityRef.current.length > 0;
      setActivity([]);
      setSystemEvents((prev) => {
        const entry: SystemEvent = {
          id: now.getTime(),
          timestamp: now.toISOString(),
          message: hadEntries
            ? "RFID Activity Cleared"
            : "RFID Activity Cleared (was empty)",
        };
        const next = [entry, ...prev];
        return next.length > SYSTEM_EVENTS_MAX_BUFFERED
          ? next.slice(0, SYSTEM_EVENTS_MAX_BUFFERED)
          : next;
      });
    }, ms);
    return () => window.clearInterval(id);
  }, [autoClearMinutes]);

  useEffect(() => {
    if (!uptimeBase) return;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - uptimeBase.atMs) / 1000);
      setUptimeNow(uptimeBase.seconds + elapsed);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [uptimeBase]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/settings", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as SettingsLite;
          if (d?.hostname) setHostname(d.hostname);
          const first = (d.connections ?? []).find(
            (c) => c.type !== "loopback" && c.device !== "lo" && c.ip4
          );
          setIp(first?.ip4 ?? "");
          setWanIp(d.wan_ip ?? "");
          setTimezone(friendlyTimezone(d.timezone ?? null));
          if (typeof d.uptime_seconds === "number") {
            setUptimeBase({ seconds: d.uptime_seconds, atMs: Date.now() });
          }
        }
      } catch {
        /* keep last good value */
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <main className="grid h-screen w-screen grid-rows-12 gap-3 overflow-hidden bg-zinc-950 p-3 text-zinc-100">
      <FlashAlertOverlay />
      <section className="row-span-2 grid grid-cols-8 gap-3">
        <MetricCard label="Tags Today"   value={metric(metrics.tags_today)}   chaseColor={changeBorderColor} chaseStyle={changeBorderStyle} chaseWidthPx={changeBorderWidthPx} chaseCycleCount={changeBorderCycleCount} forceFire={cardForceFire[0]} />
        <MetricCard label="Unique Tags"  value={metric(metrics.unique_tags_today)} chaseColor={changeBorderColor} chaseStyle={changeBorderStyle} chaseWidthPx={changeBorderWidthPx} chaseCycleCount={changeBorderCycleCount} forceFire={cardForceFire[1]} />
        <MetricCard
          label="Readers Up"
          chaseColor={changeBorderColor}
          chaseStyle={changeBorderStyle}
          chaseWidthPx={changeBorderWidthPx}
          chaseCycleCount={changeBorderCycleCount}
          forceFire={cardForceFire[2]}
          value={
            metrics.readers_up != null && metrics.readers_total != null
              ? `${metrics.readers_up} / ${metrics.readers_total}`
              : "—"
          }
        />
        <MetricCard
          label="Assets"
          chaseColor={changeBorderColor}
          chaseStyle={changeBorderStyle}
          chaseWidthPx={changeBorderWidthPx}
          chaseCycleCount={changeBorderCycleCount}
          forceFire={cardForceFire[3]}
          value={
            metrics.assets_total != null && metrics.assets_matched != null
              ? `${metrics.assets_matched} / ${metrics.assets_total}`
              : "—"
          }
        />
        <MetricCard label="Errors 24h"   value={metric(metrics.errors_24h)}   chaseColor={changeBorderColor} chaseStyle={changeBorderStyle} chaseWidthPx={changeBorderWidthPx} chaseCycleCount={changeBorderCycleCount} forceFire={cardForceFire[4]} />
        <MetricCard label="Pending Sync" value={metric(metrics.pending_sync)} chaseColor={changeBorderColor} chaseStyle={changeBorderStyle} chaseWidthPx={changeBorderWidthPx} chaseCycleCount={changeBorderCycleCount} forceFire={cardForceFire[5]} />
        <MetricCard
          label="Last Sync"
          value={metric(metrics.last_sync)}
          valueNode={(() => {
            const parts = formatLastSync(metrics.last_sync);
            if (!parts) {
              return (
                <p className="mt-1 font-mono text-5xl leading-none tabular-nums text-zinc-100">
                  —
                </p>
              );
            }
            return (
              <div className="mt-1 flex flex-col items-center leading-none">
                <span className="font-mono text-5xl tabular-nums text-zinc-100">
                  {parts.time}
                </span>
                <span className="mt-1 font-mono text-lg tabular-nums tracking-wide text-zinc-400">
                  {parts.date}
                </span>
              </div>
            );
          })()}
          chaseColor={changeBorderColor}
          chaseStyle={changeBorderStyle}
          chaseWidthPx={changeBorderWidthPx}
          chaseCycleCount={changeBorderCycleCount}
          forceFire={cardForceFire[6]}
        />
        <MetricCard label="Uptime"       value={formatUptime(uptimeNow)}      chaseColor={changeBorderColor} chaseStyle={changeBorderStyle} chaseWidthPx={changeBorderWidthPx} chaseCycleCount={changeBorderCycleCount} forceFire={cardForceFire[7]} />
      </section>

      <section className="row-span-9 grid min-h-0 grid-cols-8 gap-3">
        <div className="col-span-5 h-full min-h-0">
          <LogPanel title="RFID Activity">
            <ScanFeed entries={activity} />
          </LogPanel>
        </div>
        <div className="col-span-3 h-full min-h-0">
          <LogPanel title="System Events">
            <SystemEventsFeed events={systemEvents} />
          </LogPanel>
        </div>
      </section>

      <section className="row-span-1">
        <StatusBar
          hostname={hostname}
          ip={ip}
          wanIp={wanIp}
          time={time}
          dateStr={dateStr}
          timezone={timezone}
          reg={reg}
          lightState={lightState}
        />
      </section>
    </main>
  );
}

// MetricCard flashes a chase-border on two triggers:
//   * its `value` prop changes (organic metric change)
//   * the `forceFire` counter increments (parent-driven, used by the
//     /config/settings/screen-status Test button so the operator can see
//     the chase fire across all cards in a sequence)
// Each trigger increments an internal bump counter; ChangeBorder is keyed
// on that counter so its animation cleanly restarts every fire.

function MetricCard({
  label,
  value,
  valueNode,
  chaseColor,
  chaseStyle,
  chaseWidthPx,
  chaseCycleCount = 2,
  forceFire = 0,
}: {
  label: string;
  value: string;
  /** When provided, replaces the default text rendering of `value`. Used
   *  for cards that need a multi-line layout (e.g. Last Sync = time over
   *  date). The chase animation still keys off `value` changes for the
   *  flash trigger, so pass the canonical string in `value` even when
   *  using `valueNode`. */
  valueNode?: React.ReactNode;
  chaseColor: string;
  chaseStyle: ChangeBorderStyle;
  chaseWidthPx: number;
  chaseCycleCount?: number;
  forceFire?: number;
}) {
  const prevValueRef = useRef<string>(value);
  const prevForceRef = useRef<number>(forceFire);
  // chaseBump tracks the latest trigger. When non-null, ChangeBorder is
  // mounted (and keyed on the bump value so a back-to-back trigger
  // restarts the animation cleanly). A setTimeout sets it back to null
  // after changeBorderDurationMs(style, cycles) so the card returns to its
  // plain rendering once the configured number of revolutions completes.
  const [chaseBump, setChaseBump] = useState<number | null>(null);
  const chaseHideTimerRef = useRef<number | null>(null);
  // Track the cycle count at the moment of firing — if the setting
  // changes while a chase is in flight, the original duration sticks.
  const chaseCycleCountRef = useRef<number>(chaseCycleCount);
  useEffect(() => {
    chaseCycleCountRef.current = chaseCycleCount;
  }, [chaseCycleCount]);
  const chaseStyleRef = useRef<ChangeBorderStyle>(chaseStyle);
  useEffect(() => {
    chaseStyleRef.current = chaseStyle;
  }, [chaseStyle]);

  function fireChase() {
    if (chaseHideTimerRef.current !== null) {
      window.clearTimeout(chaseHideTimerRef.current);
    }
    const cycles = Math.max(1, chaseCycleCountRef.current);
    setChaseBump((prev) => (prev ?? 0) + 1);
    chaseHideTimerRef.current = window.setTimeout(() => {
      setChaseBump(null);
      chaseHideTimerRef.current = null;
    }, changeBorderDurationMs(chaseStyleRef.current, cycles) + 250);
  }

  useEffect(() => {
    if (prevValueRef.current !== value) {
      prevValueRef.current = value;
      fireChase();
    }
    // fireChase is stable enough that we deliberately omit it from deps;
    // its only state-touching closure (chaseHideTimerRef) is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (prevForceRef.current !== forceFire) {
      prevForceRef.current = forceFire;
      fireChase();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceFire]);

  useEffect(() => {
    return () => {
      if (chaseHideTimerRef.current !== null) {
        window.clearTimeout(chaseHideTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="relative flex flex-col items-center justify-center overflow-visible rounded-2xl border border-zinc-800 bg-zinc-900 px-2">
      {chaseBump !== null && (
        <ChangeBorder
          key={chaseBump}
          style={chaseStyle}
          color={chaseColor}
          widthPx={chaseWidthPx}
          cornerRadiusPx={16}
          cycleCount={Math.max(1, chaseCycleCount)}
        />
      )}
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </p>
      {valueNode ?? (
        <p className="mt-1 font-mono text-5xl leading-none tabular-nums text-zinc-100">
          {value}
        </p>
      )}
    </div>
  );
}

function LogPanel({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-400">
          {title}
        </h2>
        <span className="text-[10px] uppercase tracking-widest text-zinc-600">
          live
        </span>
      </header>
      <div className="flex-1 overflow-hidden p-3 font-mono text-xs text-zinc-500">
        {children ?? <p>(no entries yet)</p>}
      </div>
    </div>
  );
}

// Match Type column — display-only Title Case rendering of the raw
// match_type string from the lookup function. Empty string for unmatched.
function formatMatchType(entry: ActivityEntry): string {
  if (!entry.matched) return "—";
  const kind = (entry.match_type ?? "").toString().trim();
  if (!kind) return "—";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

// Detail column — just the per-match fields (no match_type prefix; that
// now lives in its own column). Shape per the rfid_scan_processing spec:
//   asset:  "{asset_serial_number} - {asset_make asset_model}"
//   person: "{Name}"
//   other:  raw JSON (forward-compat for future lookup sources)
// Unmatched (toggle on):
//          "{trimmed id_hex}"
function formatActivityDetail(entry: ActivityEntry): string {
  if (!entry.matched) {
    return entry.id_hex ? trimIdHex(entry.id_hex) : "";
  }
  const kind = entry.match_type ?? "";
  const data = entry.match_data ?? {};
  if (kind === "asset") {
    const serial = (data.asset_serial_number ?? "").toString().trim();
    const makeModel = [data.asset_make ?? "", data.asset_model ?? ""]
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .join(" ");
    return [serial, makeModel].filter(Boolean).join(" - ");
  }
  if (kind === "person") {
    return (data.name ?? "").toString().trim();
  }
  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
}

// ScanFeed renders only as many rows as fit in its container (no scrollbar
// — kiosk constraint). Measures the wrapper + first rendered row to derive
// the line height and divides.
function ScanFeed({ entries }: { entries: ActivityEntry[] }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const [maxVisible, setMaxVisible] = useState<number>(1);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    function recompute() {
      const w = wrapperRef.current;
      const r = rowRef.current;
      if (!w) return;
      const lineH = (r?.offsetHeight ?? 24) + 4; // +4 for space-y-1
      const fit = Math.max(1, Math.floor(w.clientHeight / lineH));
      setMaxVisible(fit);
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div ref={wrapperRef} className="flex h-full flex-col">
        <ScanHeader />
        <p className="mt-2 text-base text-zinc-500">(waiting for tags…)</p>
      </div>
    );
  }

  const visible = entries.slice(0, maxVisible);
  return (
    <div ref={wrapperRef} className="flex h-full flex-col overflow-hidden">
      <ScanHeader />
      <ul className="space-y-1 text-base leading-tight text-zinc-300">
        {visible.map((e, i) => (
          <li
            key={e.id}
            ref={i === 0 ? rowRef : undefined}
            className="grid grid-cols-[6rem_minmax(6rem,1fr)_7rem_minmax(0,2fr)] gap-x-4 tabular-nums"
          >
            <span className="text-zinc-100">
              {formatScanTime(e.event_timestamp)}
            </span>
            <span className="truncate text-zinc-100">{e.reader_name}</span>
            <span className="truncate text-zinc-100">
              {formatMatchType(e)}
            </span>
            <span className="truncate text-zinc-100">
              {formatActivityDetail(e)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScanHeader() {
  return (
    <div className="mb-2 grid grid-cols-[6rem_minmax(6rem,1fr)_7rem_minmax(0,2fr)] gap-x-4 border-b border-zinc-800 pb-1 text-[11px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
      <span>Time</span>
      <span>Reader</span>
      <span>Match Type</span>
      <span>Detail</span>
    </div>
  );
}

// SystemEventsFeed — same overflow discipline as ScanFeed.
function SystemEventsFeed({ events }: { events: SystemEvent[] }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const [maxVisible, setMaxVisible] = useState<number>(1);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    function recompute() {
      const w = wrapperRef.current;
      const r = rowRef.current;
      if (!w) return;
      const lineH = (r?.offsetHeight ?? 22) + 4;
      const fit = Math.max(1, Math.floor(w.clientHeight / lineH));
      setMaxVisible(fit);
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div ref={wrapperRef} className="flex h-full flex-col">
        <SystemEventsHeader />
        <p className="mt-2 text-sm text-zinc-500">(no events yet)</p>
      </div>
    );
  }

  const visible = events.slice(0, maxVisible);
  return (
    <div ref={wrapperRef} className="flex h-full flex-col overflow-hidden">
      <SystemEventsHeader />
      <ul className="space-y-1 text-sm leading-tight text-zinc-300">
        {visible.map((e, i) => (
          <li
            key={e.id}
            ref={i === 0 ? rowRef : undefined}
            className="grid grid-cols-[5rem_1fr] gap-x-3 tabular-nums"
          >
            <span className="text-zinc-100">
              {new Date(e.timestamp).toLocaleTimeString([], { hour12: false })}
            </span>
            <span className="truncate text-zinc-100">{e.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SystemEventsHeader() {
  return (
    <div className="mb-2 grid grid-cols-[5rem_1fr] gap-x-3 border-b border-zinc-800 pb-1 text-[11px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
      <span>Time</span>
      <span>Event</span>
    </div>
  );
}

function StatusBar({
  hostname,
  ip,
  wanIp,
  time,
  dateStr,
  timezone,
  reg,
  lightState,
}: {
  hostname: string;
  ip: string;
  wanIp: string;
  time: string;
  dateStr: string;
  timezone: string;
  reg: RegStatus;
  lightState: { red: boolean; yellow: boolean; blue: boolean; green: boolean };
}) {
  const ipDisplay = ip
    ? wanIp
      ? `${ip} (${wanIp})`
      : ip
    : "—";

  return (
    <div className="grid h-full grid-cols-[1fr_auto] items-center gap-8 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 px-5">
      <div className="flex items-center justify-between gap-6 font-mono">
        <TimeField time={time} dateStr={dateStr} timezone={timezone} />
        <Field label="Host" value={hostname} />
        <Field label="IP" value={ipDisplay} />
        <RegField status={reg} />
      </div>

      <TrafficLight state={lightState} />
    </div>
  );
}

function RegField({ status }: { status: RegStatus }) {
  const cfg = REG_DISPLAY[status];
  return (
    <div className="flex items-center gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
        Portal
      </p>
      <p className={"text-lg font-medium leading-tight " + cfg.tone}>
        {cfg.label}
      </p>
    </div>
  );
}

function TimeField({
  time,
  dateStr,
  timezone,
}: {
  time: string;
  dateStr: string;
  timezone: string;
}) {
  return (
    <div className="flex items-center gap-3 font-mono leading-none">
      <p className="text-4xl tabular-nums text-zinc-100">{time || "—"}</p>
      <div className="flex flex-col gap-1">
        <p className="text-base tabular-nums text-zinc-400">{dateStr}</p>
        {timezone && (
          <p className="text-xs tabular-nums text-zinc-500">{timezone}</p>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
        {label}
      </p>
      <p
        className={
          (mono ? "font-mono tabular-nums " : "") +
          "text-lg leading-tight text-zinc-100"
        }
      >
        {value}
      </p>
    </div>
  );
}

// Traffic light — represents the RFID subsystem state. State is computed
// by the parent from polled reader data:
//   red    : any enabled reader is in error or has no usable status
//   yellow : all readers reachable, but at least one has a non-connected
//            outbound ziotc connector
//   blue   : all readers reachable AND all connectors connected
//   green  : at least one reader's radioActivity is "active"
// Only blue and green can be lit together.
function TrafficLight({
  state,
}: {
  state: { red: boolean; yellow: boolean; blue: boolean; green: boolean };
}) {
  return (
    <div className="flex items-center gap-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
        RFID
      </p>
      <div className="flex items-center gap-2">
        <Dot color="red"    active={state.red} />
        <Dot color="yellow" active={state.yellow} />
        <Dot color="blue"   active={state.blue} />
        <Dot color="green"  active={state.green} />
      </div>
    </div>
  );
}

function Dot({
  color,
  active,
}: {
  color: "red" | "yellow" | "blue" | "green";
  active: boolean;
}) {
  const live: Record<typeof color, string> = {
    red: "bg-red-500 ring-red-400/60 shadow-[0_0_18px_rgba(239,68,68,0.6)]",
    yellow:
      "bg-yellow-400 ring-yellow-300/60 shadow-[0_0_18px_rgba(250,204,21,0.6)]",
    blue: "bg-blue-500 ring-blue-400/60 shadow-[0_0_18px_rgba(59,130,246,0.6)]",
    green:
      "bg-green-500 ring-green-400/60 shadow-[0_0_18px_rgba(34,197,94,0.6)]",
  };
  const dim: Record<typeof color, string> = {
    red: "bg-red-950 ring-red-900/40",
    yellow: "bg-yellow-950 ring-yellow-900/40",
    blue: "bg-blue-950 ring-blue-900/40",
    green: "bg-green-950 ring-green-900/40",
  };
  return (
    <span
      className={
        "block h-5 w-5 rounded-full ring-2 " +
        (active ? live[color] : dim[color])
      }
    />
  );
}
