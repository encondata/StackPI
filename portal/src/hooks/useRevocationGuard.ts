"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

const POLL_MS = 5_000;

/**
 * Kiosk-page guard: when the device's registration status flips to
 * `revoked`, navigate to `/` so the user sees the pairing QR/code shell.
 *
 * The root page (`/`) already renders the correct shell based on
 * `/local/status` (KioskHome when registered, RevokedShell briefly, then
 * PairingShell with the QR + token once the engine cycles to
 * `pre_registered`). All this hook does is push the user back there.
 *
 * Skips the redirect on `/` itself and `/config/*` — the admin needs to be
 * able to manage pairing from `/config/registration` even while revoked.
 */
export function useRevocationGuard(): void {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === "/" || pathname.startsWith("/config")) return;

    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/local/status", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as { status?: string };
        if (!cancelled && d.status === "revoked") {
          router.replace("/");
        }
      } catch {
        /* keep watching */
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pathname, router]);
}
