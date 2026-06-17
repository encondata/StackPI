"use client";

import { DeviceConfig } from "@/components/deviceconfig/DeviceConfig";

// Touchscreen Config page (kiosk route — distinct from the desktop /config/*
// admin, which the touchscreen must never navigate to).
export default function DeviceConfigPage() {
  return <DeviceConfig />;
}
