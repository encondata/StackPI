"use client";

import { Download } from "lucide-react";
import { PanelShell } from "./panelChrome";

// Placeholder — a later build will trigger a git pull + reinstall of the
// software on the Pi to match the current version on git.
export function UpdatePanel({ onBack }: { onBack: () => void }) {
  return (
    <PanelShell title="Update" onBack={onBack}>
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <Download className="h-16 w-16 text-zinc-600" strokeWidth={1.4} aria-hidden />
        <p className="text-lg font-semibold text-zinc-200">Software Update</p>
        <p className="max-w-sm text-sm text-zinc-500">
          This will pull the latest version from git and reinstall on the Pi.
          Coming soon.
        </p>
        <button
          type="button"
          disabled
          className="h-11 rounded-lg bg-zinc-800 px-6 text-sm font-semibold text-zinc-500 opacity-60"
        >
          Check for Updates
        </button>
      </div>
    </PanelShell>
  );
}
