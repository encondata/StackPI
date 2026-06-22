from fastapi.testclient import TestClient

from app.main import app
from app import alerts
from app import system_events

client = TestClient(app)


def test_fire_debounces_per_tag(monkeypatch):
    # fire() emits a System Event (which now drives the audio cue via
    # system_events.emit → audio.on_event); it no longer plays sound directly.
    emitted = []
    monkeypatch.setattr(system_events, "emit", lambda *a, **k: emitted.append(a) or True)
    monkeypatch.setattr(alerts, "_get_int", lambda k, d, lo, hi: 30)  # 30s window
    alerts._last_fired.clear()

    assert alerts.fire("TAG1", serial="S1", reader_name="R1") is True
    assert alerts.fire("TAG1", serial="S1", reader_name="R1") is False  # debounced
    assert alerts.fire("TAG2") is True  # different tag still fires
    assert len(emitted) == 2
    # event uses source 'rfid-alert', kind 'alert', severity in detail
    assert emitted[0][0] == "rfid-alert" and emitted[0][1] == "alert"
    # Message shows the serial number AND the RFID tag (id_hex) — no name, no
    # reader name (reader_name is passed but never shown).
    assert emitted[0][2] == "Not in move: SN S1 · Tag TAG1"
    # No serial → tag only.
    assert emitted[1][2] == "Not in move: Tag TAG2"


def test_fire_message_prefers_tag_over_name(monkeypatch):
    emitted = []
    monkeypatch.setattr(alerts, "play_sound", lambda: None)
    monkeypatch.setattr(system_events, "emit", lambda *a, **k: emitted.append(a) or True)
    monkeypatch.setattr(alerts, "_get_int", lambda k, d, lo, hi: 30)
    alerts._last_fired.clear()

    # Even when a name + reader are supplied, the message uses only serial + tag.
    alerts.fire("ABC123", serial="SN9", name="Big Server", reader_name="Dock-2")
    assert emitted[0][2] == "Not in move: SN SN9 · Tag ABC123"


def test_fire_message_trims_leading_zeros_on_tag(monkeypatch):
    emitted = []
    monkeypatch.setattr(alerts, "play_sound", lambda: None)
    monkeypatch.setattr(system_events, "emit", lambda *a, **k: emitted.append(a) or True)
    monkeypatch.setattr(alerts, "_get_int", lambda k, d, lo, hi: 30)
    alerts._last_fired.clear()

    alerts.fire("00000000000000ABCD12", serial="S1")
    assert emitted[0][2] == "Not in move: SN S1 · Tag ABCD12"

    # An all-zero tag keeps a single '0' (never an empty label).
    alerts._last_fired.clear()
    alerts.fire("0000")
    assert emitted[-1][2] == "Not in move: Tag 0"


def test_config_endpoint_shape():
    r = client.get("/local/alerts/config")
    assert r.status_code == 200
    b = r.json()
    assert b["debounce_seconds_default"] == 30
    assert "none" in b["sounds"]


def test_config_rejects_bad_volume():
    r = client.post(
        "/local/alerts/config",
        json={"sound_file": "none", "volume_pct": 150, "debounce_seconds": 30},
    )
    assert r.status_code == 422


def test_config_rejects_unknown_sound(monkeypatch):
    monkeypatch.setattr(alerts, "list_sounds", lambda: ["alert.wav"])
    r = client.post(
        "/local/alerts/config",
        json={"sound_file": "nope.wav", "volume_pct": 80, "debounce_seconds": 30},
    )
    assert r.status_code == 400


def test_test_endpoint_plays(monkeypatch):
    played = []
    monkeypatch.setattr(alerts, "play_sound", lambda: played.append(1))
    r = client.post("/local/alerts/test")
    assert r.status_code == 200
    assert played
