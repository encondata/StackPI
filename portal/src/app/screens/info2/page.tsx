"use client";

import { ScreenRenderer } from "@/components/ScreenRenderer";

// HDMI2 info display. Renders the screen selected for "info2", with Cycle
// support — see ScreenRenderer.
export default function Info2Screen() {
  return <ScreenRenderer screenId="info2" />;
}
