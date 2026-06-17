"use client";

import { ScreenRenderer } from "@/components/ScreenRenderer";

// HDMI1 info display. Renders the screen selected for "info1", with Cycle
// support — see ScreenRenderer.
export default function Info1Screen() {
  return <ScreenRenderer screenId="info1" />;
}
