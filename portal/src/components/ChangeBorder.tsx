"use client";

import { useId, useLayoutEffect, useRef } from "react";
import gsap from "gsap";

/**
 * Change-border animations for /status metric cards. One of three styles
 * fires on a card change (the parent keys/remounts the component per fire
 * and unmounts it after changeBorderDurationMs(...) elapses).
 *
 * Shared SVG sizing math (same as the old ChaseBorder): the SVG is inset by
 * half the stroke width on every side so the stroke's outer edge lands on
 * the card edge; pathLength=100 normalizes the perimeter so dash values are
 * percentage-like; non-scaling-stroke keeps the visible width constant;
 * overflow:visible keeps the outer half of the stroke painted.
 */

export const CHANGE_BORDER_STYLES = {
  comet: { label: "Comet", perCycleMs: 1600 },
  pulse: { label: "Pulse", perCycleMs: 600 },
  dual: { label: "Dual", perCycleMs: 1500 },
} as const;

export type ChangeBorderStyle = keyof typeof CHANGE_BORDER_STYLES;

export const CHANGE_BORDER_STYLE_LIST = Object.keys(
  CHANGE_BORDER_STYLES,
) as ChangeBorderStyle[];

/** Narrow an arbitrary string to a known style, falling back to comet. */
export function toChangeBorderStyle(
  s: string | undefined | null,
): ChangeBorderStyle {
  return s != null && s in CHANGE_BORDER_STYLES
    ? (s as ChangeBorderStyle)
    : "comet";
}

/** Total on-screen time for one fire (one revolution/pulse per cycle). The
 *  parent uses this to schedule unmount; add a small buffer on top. */
export function changeBorderDurationMs(
  style: ChangeBorderStyle,
  cycleCount: number,
): number {
  return CHANGE_BORDER_STYLES[style].perCycleMs * Math.max(1, cycleCount);
}

type StyleProps = {
  color: string;
  widthPx: number;
  cornerRadiusPx: number;
  cycleCount: number;
};

export function ChangeBorder({
  style,
  ...rest
}: StyleProps & { style: ChangeBorderStyle; loop?: boolean }) {
  if (style === "pulse") return <PulseBorder {...rest} />;
  if (style === "dual") return <DualBorder {...rest} />;
  return <CometBorder {...rest} />;
}

// useId() returns ids containing ":" which are invalid in SVG/CSS url(#…)
// references, so strip them.
function useGlowId(): string {
  return "cb-glow-" + useId().replace(/:/g, "");
}

function BorderSvg({
  widthPx,
  glowId,
  children,
}: {
  widthPx: number;
  glowId: string;
  children: React.ReactNode;
}) {
  const half = widthPx / 2;
  return (
    <svg
      className="pointer-events-none absolute"
      style={{
        top: half,
        left: half,
        width: `calc(100% - ${widthPx}px)`,
        height: `calc(100% - ${widthPx}px)`,
        overflow: "visible",
      }}
      aria-hidden
    >
      <defs>
        <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={Math.max(1.5, half * 0.6)} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {children}
    </svg>
  );
}

function rectProps(color: string, widthPx: number, cornerRadiusPx: number) {
  const half = widthPx / 2;
  return {
    x: 0,
    y: 0,
    width: "100%",
    height: "100%",
    rx: Math.max(0, cornerRadiusPx - half),
    ry: Math.max(0, cornerRadiusPx - half),
    fill: "none",
    stroke: color,
    strokeWidth: widthPx,
    pathLength: 100,
    strokeLinecap: "round" as const,
    vectorEffect: "non-scaling-stroke" as const,
  };
}

// Comet: a single glowing head+trail dash travels the perimeter, one full
// revolution per cycle, at constant speed.
function CometBorder({ color, widthPx, cornerRadiusPx, cycleCount, loop = false }: StyleProps & { loop?: boolean }) {
  const glowId = useGlowId();
  const ref = useRef<SVGRectElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cycles = Math.max(1, cycleCount);
    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { attr: { "stroke-dashoffset": 0 } },
        {
          attr: { "stroke-dashoffset": -100 * cycles },
          duration: changeBorderDurationMs("comet", cycleCount) / 1000,
          ease: "none",
          repeat: loop ? -1 : 0,
        },
      );
    });
    return () => ctx.revert();
  }, [cycleCount, loop]);
  return (
    <BorderSvg widthPx={widthPx} glowId={glowId}>
      <rect
        ref={ref}
        {...rectProps(color, widthPx, cornerRadiusPx)}
        strokeDasharray="18 82"
        filter={`url(#${glowId})`}
      />
    </BorderSvg>
  );
}

// Dual: two glowing segments offset half a perimeter apart chase together.
function DualBorder({ color, widthPx, cornerRadiusPx, cycleCount, loop = false }: StyleProps & { loop?: boolean }) {
  const glowId = useGlowId();
  const aRef = useRef<SVGRectElement>(null);
  const bRef = useRef<SVGRectElement>(null);
  useLayoutEffect(() => {
    const cycles = Math.max(1, cycleCount);
    const dur = changeBorderDurationMs("dual", cycleCount) / 1000;
    const ctx = gsap.context(() => {
      [
        { el: aRef.current, start: 0 },
        { el: bRef.current, start: 50 },
      ].forEach(({ el, start }) => {
        if (!el) return;
        gsap.fromTo(
          el,
          { attr: { "stroke-dashoffset": -start } },
          {
            attr: { "stroke-dashoffset": -(start + 100 * cycles) },
            duration: dur,
            ease: "none",
            repeat: loop ? -1 : 0,
          },
        );
      });
    });
    return () => ctx.revert();
  }, [cycleCount, loop]);
  const rp = rectProps(color, widthPx, cornerRadiusPx);
  return (
    <BorderSvg widthPx={widthPx} glowId={glowId}>
      <rect ref={aRef} {...rp} strokeDasharray="14 86" filter={`url(#${glowId})`} />
      <rect ref={bRef} {...rp} strokeDasharray="14 86" filter={`url(#${glowId})`} />
    </BorderSvg>
  );
}

// Pulse: the whole perimeter ignites and dims `cycleCount` times, then fades.
function PulseBorder({ color, widthPx, cornerRadiusPx, cycleCount, loop = false }: StyleProps & { loop?: boolean }) {
  const glowId = useGlowId();
  const ref = useRef<SVGRectElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cycles = Math.max(1, cycleCount);
    const per = CHANGE_BORDER_STYLES.pulse.perCycleMs / 1000;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ repeat: loop ? -1 : 0 });
      tl.set(el, { opacity: 0 });
      for (let i = 0; i < cycles; i++) {
        tl.to(el, { opacity: 1, duration: per * 0.3, ease: "power2.out" }).to(
          el,
          { opacity: 0.2, duration: per * 0.7, ease: "sine.inOut" },
        );
      }
      // When looping (continuous "reading" indicator) keep pulsing without a
      // full fade-out between groups; a single fire fades out at the end.
      if (!loop) tl.to(el, { opacity: 0, duration: 0.2, ease: "power2.in" });
    });
    return () => ctx.revert();
  }, [cycleCount, loop]);
  return (
    <BorderSvg widthPx={widthPx} glowId={glowId}>
      <rect
        ref={ref}
        {...rectProps(color, widthPx, cornerRadiusPx)}
        filter={`url(#${glowId})`}
      />
    </BorderSvg>
  );
}
