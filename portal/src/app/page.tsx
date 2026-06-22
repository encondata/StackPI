"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { QRCodeSVG } from "qrcode.react";
import { KioskHome } from "@/components/KioskHome";
import { KioskInternet } from "@/components/KioskInternet";

type LocalStatus = {
  status?: "pre_registered" | "registered" | "revoked" | "unknown";
  device_uuid?: string | null;
  name?: string | null;
  pairing_token?: string | null;
  pairing_token_expires_at?: string | null;
  link_url?: string | null;
  connectivity?: string;
};

const POLL_INTERVAL_MS = 5_000;

async function fetchStatus(): Promise<LocalStatus> {
  const res = await fetch("/local/status", { cache: "no-store" });
  if (!res.ok) return { status: "unknown" };
  return (await res.json()) as LocalStatus;
}

export default function KioskRoot() {
  const [data, setData] = useState<LocalStatus | null>(null);
  const [internetOk, setInternetOk] = useState<boolean | null>(null);
  const [ip, setIp] = useState<string>("");

  const statusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    statusRef.current = data?.status;
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const s = await fetchStatus();
        if (!cancelled) setData(s);
      } catch {
        if (!cancelled) setData((d) => d ?? { status: "unknown" });
      }
    }
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      // Only needed while NOT registered — skip the pings otherwise.
      const s = statusRef.current;
      if (s === "registered" || s === "revoked") return;
      try {
        const r = await fetch("/local/settings/connectivity", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as { internet_ok?: boolean };
          if (typeof d.internet_ok === "boolean") setInternetOk(d.internet_ok);
        }
      } catch {
        /* keep last */
      }
    }
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // This device's own LAN IP (shown on the pairing screen so an operator can
  // browse to it). Same source as the /status footer.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch("/local/settings", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as {
            connections?: Array<{ type?: string; device?: string; ip4?: string | null }>;
          };
          const first = (d.connections ?? []).find(
            (c) => c.type !== "loopback" && c.device !== "lo" && c.ip4
          );
          if (first?.ip4) setIp(first.ip4);
        }
      } catch {
        /* keep last good value */
      }
    }
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!data) return <LoadingShell />;
  if (data.status === "registered")
    return <KioskHome offline={data.connectivity === "offline"} />;
  if (data.status === "revoked") return <RevokedShell />;
  if (data.status === "pre_registered" && data.pairing_token) {
    return <PairingShell data={data} ip={ip} />;
  }
  // Not registered and no pairing code yet. If we've confirmed there's no
  // internet, the device can't fetch a code — send the operator to the
  // kiosk Internet page so they can get online; once connectivity + a code
  // arrive, the status poll above advances to the pairing screen.
  if (internetOk === false) return <KioskInternet mode="onboarding" />;
  return <LoadingShell />;
}

function LoadingShell() {
  return (
    <main className="flex h-screen w-full overflow-hidden flex-col items-center justify-center gap-4 bg-white p-8">
      <Image
        src="/stackpi-logo.png"
        alt="StackPI"
        width={1200}
        height={800}
        priority
        className="h-auto w-full max-w-[280px] object-contain opacity-90"
      />
      <p className="text-sm text-zinc-500">Loading…</p>
    </main>
  );
}

function RevokedShell() {
  return (
    <main className="flex h-screen w-full overflow-hidden flex-col items-center justify-center gap-3 bg-white p-8">
      <h1 className="text-2xl font-semibold text-red-600">Device de-registered</h1>
      <p className="text-zinc-600">Re-pairing…</p>
    </main>
  );
}

function PairingShell({ data, ip }: { data: LocalStatus; ip: string }) {
  const token = data.pairing_token ?? "";
  const link = data.link_url ?? "";
  // link_url is expected to be an absolute URL when STACKPI_LINK_URL_BASE is
  // configured server-side; if it comes back relative, the QR still encodes
  // it as-is — fix STACKPI_LINK_URL_BASE on the API rather than papering over.
  return (
    <main className="flex h-screen w-full overflow-hidden bg-white">
      {/* Left half — logo + pairing status, vertically centered */}
      <div className="flex w-1/2 flex-col items-center justify-center gap-4 p-6">
        <Image
          src="/stackpi-logo.png"
          alt="StackPI"
          width={1200}
          height={800}
          priority
          className="h-auto w-full max-w-[280px] object-contain"
        />
        {ip && (
          <p className="font-mono text-base text-zinc-700">
            <span className="text-zinc-400">IP </span>
            {ip}
          </p>
        )}
        <p className="text-sm text-zinc-500">Waiting for pairing…</p>
      </div>

      {/* Right half — QR on top, pairing code below */}
      <div className="flex w-1/2 flex-col items-center justify-center gap-4 border-l border-zinc-100 p-6">
        {link && (
          <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
            <QRCodeSVG value={link} size={150} />
          </div>
        )}
        <p className="text-xs uppercase tracking-widest text-zinc-400">
          Pairing token
        </p>
        <div className="font-mono text-6xl font-bold tracking-[0.15em] text-zinc-900">
          {token}
        </div>
        <p className="text-center text-xs text-zinc-500">
          Device: <span className="font-medium text-zinc-700">{data.name ?? "?"}</span>
          {data.pairing_token_expires_at && (
            <>
              {" · "}Expires{" "}
              {new Date(data.pairing_token_expires_at).toLocaleTimeString()}
            </>
          )}
        </p>
      </div>
    </main>
  );
}
