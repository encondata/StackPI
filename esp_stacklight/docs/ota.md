# esp_stacklight — firmware updates (USB + OTA)

There are three ways to update the device. The **first** flash of any OTA-capable
build must go over **USB**; after that you can update over Wi-Fi.

## 1. First-time / recovery flash — USB (required once)

Connect the ESP32 to the Mac by USB, then from `esp_stacklight/`:

```bash
pio run -e esp32dev -t upload
```

- The upload port is pinned to the USB-serial adapter (`/dev/cu.usbserial*`) in
  `platformio.ini`, so PlatformIO won't grab the Bluetooth port.
- If it stalls at `Connecting....`, hold the **BOOT** button until it starts
  writing.
- WAV files (LittleFS) only need flashing when they change:
  ```bash
  pio run -e esp32dev -t uploadfs
  ```
  Run `upload` and `uploadfs` as **separate** commands (combining them in one
  invocation uploads the filesystem twice and skips the app).

Once an OTA-capable build is running, use either method below — no cable needed.

## 2. Web OTA — browser (ElegantOTA)

In a browser on the same network:

```
http://<device-ip>/update      (or  http://stacklight.local/update)
```

- Upload `firmware.bin` (the **Firmware** option) or the LittleFS image (the
  **Filesystem** option).
- File locations after a build:
  - firmware: `.pio/build/esp32dev/firmware.bin`
  - filesystem: `.pio/build/esp32dev/littlefs.bin`
- The device IP is printed at boot (`[net] connected: ... ip=...`) and on the
  test page line (`[web] ... OTA: http://<ip>/update`).

## 3. PlatformIO push — Wi-Fi (ArduinoOTA / espota)

From `esp_stacklight/`:

```bash
pio run -e ota -t upload
```

- The `ota` env uses `upload_protocol = espota` and targets `stacklight.local`.
- If mDNS doesn't resolve on your network, pass the IP explicitly:
  ```bash
  pio run -e ota -t upload --upload-port 10.10.48.166
  ```
- Build the firmware first if needed: `pio run -e esp32dev`.

## Authentication (optional)

OTA is open on the LAN by default. To require a password, set `OTA_PASSWORD`
(and `OTA_USERNAME`) in `src/config.h`, then flash once over USB. It then
applies to both the `/update` web page and the `pio`/espota push.

## Notes

- **Partitions:** the default 4 MB layout already has two app slots
  (`app0` + `app1`), so OTA works without a custom partition table. The app is
  ~77% of one 1.25 MB slot.
- **OTA can't recover a bricked unit** — if a bad image won't boot, reflash over
  USB (method 1).
- **Hostname / mDNS:** `OTA_HOSTNAME` in `config.h` (default `stacklight` →
  `stacklight.local`).
