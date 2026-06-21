# esp_stacklight — wiring

Wiring for the ESP32 stack-light / speaker controller. Pin assignments are the
source-of-truth values from [`src/config.h`](../src/config.h).

## Block diagram

```
            +24V                          +24V ×4
 24V DC ───────────► 4-ch MOSFET ──────────────► stack light (R/Y/G/B)
 supply │            board                       24V LED tower
        │              ▲
        │ +24V         │ GPIO 16–19 (PWM) + GND
        ▼              │
 24V→5V buck     ESP-WROOM-32
        │  +5V    │   │
        └────────►│   │ GPIO 27/26/25 (I2S) + 5V/GND
                  │   ▼
                  │  MAX98357A ──────► speaker (±)
                  │  I2S amp
                 (Wi-Fi MCU)
```

> The rendered SVG version of this diagram is reproduced at the bottom of this
> file.

## Connections

### ESP32 → 4-channel MOSFET board (lamps)

| ESP32 pin | MOSFET input | Stack-light color |
|---|---|---|
| GPIO16 | IN1 | red |
| GPIO17 | IN2 | green |
| GPIO18 | IN3 | yellow |
| GPIO19 | IN4 | blue |
| GND | GND | — |

- The IN pins are driven with LEDC PWM (5 kHz, 8-bit) for brightness. 3.3 V logic
  drives the board directly — no level shifter needed.
- Each MOSFET channel switches its lamp; the stack light's common rail is +24 V,
  and each color's return goes to its channel output.

### ESP32 → MAX98357A (audio)

| ESP32 pin | MAX98357A pin |
|---|---|
| GPIO27 | BCLK |
| GPIO26 | LRC |
| GPIO25 | DIN |
| 5V | VIN |
| GND | GND |

- Tie the amp's `SD` (shutdown) pin high so it stays enabled.
- Speaker connects to the amp's `+` / `-` output terminals.

### Power

| Source | Feeds |
|---|---|
| 24 V DC supply | MOSFET board load input (lamps) + 24 V→5 V buck |
| 24 V→5 V buck | ESP `5V/VIN` (and the ESP's 5 V rail feeds the MAX98357A `VIN`) |

### Ground

**Tie every ground together** — ESP GND, MOSFET board GND, MAX98357A GND, the
24 V supply return, and the buck's grounds must share a common reference.
Without a common ground the PWM logic will not switch the MOSFETs reliably.

## Notes

- The tower is a 24 V **LED** stack light, which is why PWM dimming works.
- The color → pin mapping above matches `LAMP_PINS[]` in
  [`src/lamps.cpp`](../src/lamps.cpp) and the `Color` enum in
  [`src/protocol.h`](../src/protocol.h).
- See the [design spec](superpowers/specs/2026-06-21-esp-stacklight-firmware-design.md)
  for the full hardware/firmware picture.

## Diagram (SVG)

```svg
<svg width="100%" viewBox="0 0 680 450" role="img" xmlns="http://www.w3.org/2000/svg">
<title>ESP32 stack-light and speaker wiring diagram</title>
<desc>A 24V supply powers the 4-channel MOSFET board for the lamps and a buck converter for 5V logic. The ESP-WROOM-32 drives the MOSFET board with GPIO 16-19 PWM and the MAX98357A amplifier over I2S on GPIO 27, 26, 25. The MOSFET board switches the four stack-light colors; the amplifier drives the speaker. All grounds are common.</desc>
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-rev"><path d="M0,0 L10,5 L0,10 z" fill="#5F5E5A"/></marker>
</defs>
<rect x="40" y="44" width="170" height="50" rx="8" fill="#FAEEDA" stroke="#BA7517"/><text x="125" y="68" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#633806">24V to 5V buck</text><text x="125" y="84" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#854F0B">logic power</text>
<rect x="270" y="44" width="170" height="50" rx="8" fill="#FAEEDA" stroke="#BA7517"/><text x="355" y="68" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#633806">24V DC supply</text><text x="355" y="84" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#854F0B">lamp power</text>
<rect x="40" y="170" width="160" height="210" rx="8" fill="#EEEDFE" stroke="#534AB7"/><text x="120" y="200" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#3C3489">ESP-WROOM-32</text><text x="120" y="220" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#534AB7">Wi-Fi / multicast</text>
<rect x="290" y="150" width="150" height="80" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text x="365" y="186" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#085041">4-ch MOSFET</text><text x="365" y="206" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#0F6E56">PWM / 24V 10A</text>
<rect x="290" y="300" width="150" height="70" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text x="365" y="332" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#085041">MAX98357A</text><text x="365" y="352" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#0F6E56">I2S amp</text>
<rect x="510" y="120" width="130" height="166" rx="8" fill="#F1EFE8" stroke="#5F5E5A"/><text x="575" y="142" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#2C2C2A">stack light 24V</text>
<rect x="524" y="152" width="102" height="24" rx="4" fill="#FCEBEB" stroke="#A32D2D"/><text x="575" y="168" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#791F1F">red</text>
<rect x="524" y="182" width="102" height="24" rx="4" fill="#FAEEDA" stroke="#854F0B"/><text x="575" y="198" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#633806">yellow</text>
<rect x="524" y="212" width="102" height="24" rx="4" fill="#EAF3DE" stroke="#3B6D11"/><text x="575" y="228" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#27500A">green</text>
<rect x="524" y="242" width="102" height="24" rx="4" fill="#E6F1FB" stroke="#185FA5"/><text x="575" y="258" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#0C447C">blue</text>
<rect x="510" y="312" width="130" height="58" rx="8" fill="#F1EFE8" stroke="#5F5E5A"/><text x="575" y="346" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#2C2C2A">speaker</text>
<line x1="200" y1="190" x2="286" y2="190" stroke="#378ADD" stroke-width="1.6" marker-end="url(#arrow)"/><text x="243" y="182" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">GPIO 16-19</text><text x="243" y="206" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">PWM</text>
<line x1="200" y1="330" x2="286" y2="330" stroke="#378ADD" stroke-width="1.6" marker-end="url(#arrow)"/><text x="243" y="322" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">GPIO 27/26/25</text><text x="243" y="344" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">I2S + 5V</text>
<line x1="440" y1="190" x2="508" y2="190" stroke="#BA7517" stroke-width="1.6" marker-end="url(#arrow)"/><text x="474" y="182" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">24V x4</text>
<line x1="440" y1="335" x2="508" y2="335" stroke="#378ADD" stroke-width="1.6" marker-end="url(#arrow)"/><text x="474" y="327" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">spkr +/-</text>
<line x1="268" y1="69" x2="214" y2="69" stroke="#BA7517" stroke-width="1.6" marker-end="url(#arrow)"/><text x="241" y="62" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">+24V</text>
<line x1="110" y1="96" x2="110" y2="168" stroke="#BA7517" stroke-width="1.6" marker-end="url(#arrow)"/><text x="120" y="136" text-anchor="start" font-family="sans-serif" font-size="12" fill="#5F5E5A">+5V</text>
<line x1="360" y1="96" x2="360" y2="148" stroke="#BA7517" stroke-width="1.6" marker-end="url(#arrow)"/><text x="370" y="126" text-anchor="start" font-family="sans-serif" font-size="12" fill="#5F5E5A">+24V</text>
<line x1="40" y1="412" x2="70" y2="412" stroke="#378ADD" stroke-width="1.6"/><text x="76" y="416" text-anchor="start" font-family="sans-serif" font-size="12" fill="#5F5E5A">signal (GPIO / I2S)</text>
<line x1="240" y1="412" x2="270" y2="412" stroke="#BA7517" stroke-width="1.6"/><text x="276" y="416" text-anchor="start" font-family="sans-serif" font-size="12" fill="#5F5E5A">power (24V / 5V)</text>
<text x="470" y="416" text-anchor="start" font-family="sans-serif" font-size="12" fill="#5F5E5A">tie all grounds common</text>
</svg>
```
