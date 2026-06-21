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

// --- LEDC PWM ---
#define LEDC_FREQ_HZ     5000
#define LEDC_RES_BITS    8        // duty 0..255

// --- Multicast defaults (operator-overridable, persisted to NVS) ---
#define DEFAULT_MCAST_GROUP "239.10.10.10"
#define DEFAULT_MCAST_PORT  5005

// --- Captive portal ---
#define AP_NAME          "StackLight-Setup"
