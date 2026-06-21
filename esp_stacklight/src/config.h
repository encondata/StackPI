#pragma once

// --- Lamp output pins (to MOSFET IN1..IN4) ---
#define PIN_LAMP_RED     16
#define PIN_LAMP_GREEN   17
#define PIN_LAMP_YELLOW  18
#define PIN_LAMP_BLUE    19

// --- I2S audio (MAX98357A) ---
#define PIN_I2S_BCLK     27
#define PIN_I2S_LRC      26
#define PIN_I2S_DIN      25

// --- Lamp driver ---
// 1 = relay board (digital on/off);  0 = MOSFET board (PWM dimming).
#define USE_RELAYS       1
// Most 4-channel relay modules are active-low (IN pulled LOW energizes the
// relay). Set to 0 if yours energizes on HIGH.
#define RELAY_ACTIVE_LOW 1

// --- LEDC PWM (used only when USE_RELAYS = 0) ---
#define LEDC_FREQ_HZ     5000
#define LEDC_RES_BITS    8        // duty 0..255

// --- Multicast defaults (operator-overridable, persisted to NVS) ---
#define DEFAULT_MCAST_GROUP "239.10.10.10"
#define DEFAULT_MCAST_PORT  5005

// --- Captive portal ---
#define AP_NAME          "StackLight-Setup"

// --- Default Wi-Fi (preloaded on first boot; operator can still override via
//     the captive portal, after which the saved creds take priority) ---
#define DEFAULT_WIFI_SSID "HSL-IOT"
#define DEFAULT_WIFI_PASS "bb169ea953"

// --- Boot sound (played once at startup; ignored if the WAV is missing) ---
#define BOOT_SOUND_ID    "alert"
