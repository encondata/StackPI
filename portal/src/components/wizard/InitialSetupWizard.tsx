"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { StepSelectMove } from "./StepSelectMove";
import { StepReader } from "./StepReader";
import { StepSiteScan } from "./StepSiteScan";
import { StepSummary } from "./StepSummary";

// Shared state threaded through the steps. Step 1 sets move*, Step 2 sets
// readerName, Step 3 sets site*/scanType*. Step 4 (StepSummary) commits to the
// portal and optionally starts the radio.
export type WizardState = {
  moveId: number | null;
  moveName: string | null;
  readerName: string | null;
  // True once the selected reader's endpoint has been verified pointing at this
  // Pi (set by StepReader). Gates Step 2's Next.
  endpointVerified: boolean;
  siteId: number | null;
  siteName: string | null;
  scanTypeId: number | null;
  scanTypeName: string | null;
};

export type StepProps = {
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
};

const STEP_TITLES = ["Select Move", "RFID Reader", "Site & Scan Type", "Confirm"];
const LAST_STEP = 4;

export function InitialSetupWizard() {
  const router = useRouter();
  const [step, setStep] = useState<number>(1);
  const [state, setState] = useState<WizardState>({
    moveId: null,
    moveName: null,
    readerName: null,
    endpointVerified: false,
    siteId: null,
    siteName: null,
    scanTypeId: null,
    scanTypeName: null,
  });

  const update = (patch: Partial<WizardState>) =>
    setState((s) => ({ ...s, ...patch }));

  const canNext =
    step === 1
      ? state.moveId != null
      : step === 2
        ? state.readerName != null && state.endpointVerified
        : state.siteId != null && state.scanTypeId != null;

  function goPrev() {
    if (step === 1) {
      router.push("/");
      return;
    }
    setStep((s) => s - 1);
  }

  function goNext() {
    setStep((s) => Math.min(LAST_STEP, s + 1));
  }

  return (
    <main className="relative flex h-screen w-screen flex-col gap-3 overflow-hidden bg-zinc-950 p-4 text-zinc-100">
      <header className="flex h-9 flex-none items-center gap-3">
        <div className="text-xl font-semibold">Initial Setup</div>
        <div className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
          {STEP_TITLES[step - 1]}
          {[1, 2, 3, 4].map((n) => (
            <span
              key={n}
              className={
                "h-2.5 w-2.5 rounded-full " +
                (n < step ? "bg-green-600" : n === step ? "bg-blue-600" : "bg-zinc-700")
              }
            />
          ))}
        </div>
      </header>

      <section className="flex min-h-0 flex-1 flex-col">
        {step === 1 && <StepSelectMove state={state} update={update} />}
        {step === 2 && <StepReader state={state} update={update} />}
        {step === 3 && <StepSiteScan state={state} update={update} />}
        {step === 4 && <StepSummary state={state} onHome={() => router.push("/")} />}
      </section>

      <footer className="flex h-[52px] flex-none items-center gap-3 border-t border-zinc-800 pt-3">
        <button
          type="button"
          onClick={goPrev}
          className="flex h-10 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 text-sm font-medium text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" /> {step === 1 ? "Home" : "Previous"}
        </button>
        <div className="flex-1" />
        <span className="text-xs text-zinc-500">
          Step {step} of {LAST_STEP}
        </span>
        {step < LAST_STEP && (
          <button
            type="button"
            onClick={goNext}
            disabled={!canNext}
            className="flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-semibold text-white disabled:opacity-40"
          >
            Next <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </footer>
    </main>
  );
}
