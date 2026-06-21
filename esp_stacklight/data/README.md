# LittleFS audio assets

Place 16-bit PCM **mono** WAV files here. Filenames must match `src/sound_map.cpp`:

- `alert.wav`
- `error.wav`
- `info.wav`

Convert with, e.g.:

    ffmpeg -i input.mp3 -ac 1 -ar 22050 -sample_fmt s16 alert.wav

Upload to the device with:

    pio run -e esp32dev -t uploadfs
