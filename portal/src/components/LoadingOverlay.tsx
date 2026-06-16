"use client";

import { Loader2 } from "lucide-react";

// Full-surface wait overlay. Anchors to the nearest positioned ancestor —
// the wizard <main> is `relative`, so it covers the whole wizard while a
// step loads. z-30 sits above the dropdown/panel overlays (z-20).
export function LoadingOverlay({ show, label }: { show: boolean; label?: string }) {
  if (!show) return null;
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-zinc-950/70 backdrop-blur-sm">
      <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
      <p className="text-sm text-zinc-300">{label ?? "Loading…"}</p>
    </div>
  );
}
