"use client";

import { ScreenRenderer } from "@/components/ScreenRenderer";

// Touchscreen display route. Renders the screen selected for "touch", with
// Cycle support — see ScreenRenderer. The touchscreen normally loads the kiosk
// menu (/); point its output here to use it as a display.
export default function TouchScreen() {
  return <ScreenRenderer screenId="touch" />;
}
