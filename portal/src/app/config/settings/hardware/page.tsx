"use client";

import { useEffect, useState } from "react";
import {
  Banner,
  BannerBar,
  CollapsibleSection,
  Dropdown,
} from "@/components/settings/parts";

type Hardware = {
  stacklight_enable: "3-color" | "4-color" | "not_installed" | string;
  audio_feedback: "all" | "none" | "error_only" | string;
};

const STACKLIGHT_OPTIONS = [
  { value: "3-color", label: "3-Color Stack" },
  { value: "4-color", label: "4-Color Stack" },
  { value: "not_installed", label: "Not Installed" },
];

const AUDIO_OPTIONS = [
  { value: "all", label: "All" },
  { value: "none", label: "None" },
  { value: "error_only", label: "Error Only" },
];

export default function HardwareSettingsPage() {
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [busy, setBusy] = useState<null | "hardware">(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    refreshHardware();
  }, []);

  async function refreshHardware() {
    try {
      const res = await fetch("/local/settings/hardware", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as Hardware;
      setHardware(data);
    } catch {
      /* keep last good data */
    }
  }

  function flash(kind: Banner["kind"], text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 7000);
  }

  async function saveHardware(patch: Partial<Hardware>) {
    setBusy("hardware");
    try {
      const res = await fetch("/local/settings/hardware", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        setHardware(body as Hardware);
        flash("success", "Hardware setting saved.");
      } else {
        flash("error", body?.detail ?? "Failed to save hardware setting.");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Hardware</h1>
        <p className="text-sm text-zinc-500">
          Optional peripherals controlled by the StackPI engine.
        </p>
      </header>

      {banner && <BannerBar banner={banner} />}

      <CollapsibleSection title="Hardware">
        <p className="text-xs text-zinc-500">
          Changes apply immediately — no reboot required.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Dropdown
            label="StackLight enable"
            value={hardware?.stacklight_enable ?? ""}
            options={STACKLIGHT_OPTIONS}
            disabled={busy !== null || !hardware}
            onChange={(v) =>
              saveHardware({
                stacklight_enable: v as Hardware["stacklight_enable"],
              })
            }
          />
          <Dropdown
            label="Audio feedback"
            value={hardware?.audio_feedback ?? ""}
            options={AUDIO_OPTIONS}
            disabled={busy !== null || !hardware}
            onChange={(v) =>
              saveHardware({ audio_feedback: v as Hardware["audio_feedback"] })
            }
          />
        </div>
      </CollapsibleSection>
    </div>
  );
}
