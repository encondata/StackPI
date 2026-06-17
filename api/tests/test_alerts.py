from fastapi.testclient import TestClient

from app.main import app
from app import alerts
from app import system_events

client = TestClient(app)


def test_fire_debounces_per_tag(monkeypatch):
    played, emitted = [], []
    monkeypatch.setattr(alerts, "play_sound", lambda: played.append(1))
    monkeypatch.setattr(system_events, "emit", lambda *a, **k: emitted.append(a) or True)
    monkeypatch.setattr(alerts, "_get_int", lambda k, d, lo, hi: 30)  # 30s window
    alerts._last_fired.clear()

    assert alerts.fire("TAG1", serial="S1", reader_name="R1") is True
    assert alerts.fire("TAG1", serial="S1", reader_name="R1") is False  # debounced
    assert alerts.fire("TAG2") is True  # different tag still fires
    assert len(played) == 2
    assert len(emitted) == 2
    # event uses source 'rfid-alert', kind 'alert', severity in detail
    assert emitted[0][0] == "rfid-alert" and emitted[0][1] == "alert"


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
