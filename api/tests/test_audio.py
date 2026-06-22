from fastapi.testclient import TestClient

from app.main import app
from app import audio

client = TestClient(app)


def test_category_for_mapping() -> None:
    # critical → error (the 'not in move' bad-tag is kind=alert, detail=critical)
    assert audio.category_for("alert", "critical") == "error"
    assert audio.category_for("error", None) == "error"
    # warning → alert
    assert audio.category_for("alert", "warning") == "alert"
    assert audio.category_for("warning", None) == "alert"
    # info / success → info
    assert audio.category_for("info", None) == "info"
    assert audio.category_for("success", None) == "info"
    # unknown → no category
    assert audio.category_for("debug", None) is None


def test_play_respects_enable_and_debounce(monkeypatch) -> None:
    played = []
    monkeypatch.setattr(audio, "_play_file", lambda f, v: played.append((f, v)))
    monkeypatch.setattr(audio, "_category_sound", lambda c: "alert.wav")
    monkeypatch.setattr(audio, "_get_int", lambda k, d, lo, hi: 80)
    audio._last_played.clear()

    # disabled → silent
    monkeypatch.setattr(audio, "_category_enabled", lambda c: False)
    audio.play("info")
    assert played == []

    # enabled → plays once, then debounced
    monkeypatch.setattr(audio, "_category_enabled", lambda c: True)
    audio.play("error")
    audio.play("error")  # within DEBOUNCE_SEC → suppressed
    assert played == [("alert.wav", 80)]


def test_on_event_plays_mapped_category(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(audio, "play", lambda c: calls.append(c))
    audio.on_event("alert", "critical")   # → error
    audio.on_event("success", None)        # → info
    audio.on_event("debug", None)          # → nothing
    assert calls == ["error", "info"]


def test_audio_config_get(monkeypatch) -> None:
    monkeypatch.setattr(audio, "list_sounds", lambda: ["alert.wav", "buzz.wav", "chime.wav"])
    monkeypatch.setattr("app.settings._get_setting_str", lambda k, d: d)
    monkeypatch.setattr("app.settings._get_setting_int", lambda k, d, lo, hi: d)
    body = client.get("/local/audio/config").json()
    assert [c["id"] for c in body["categories"]] == ["error", "alert", "info"]
    assert body["sounds"][0] == "none" and "alert.wav" in body["sounds"]


def test_audio_config_post_persists(monkeypatch) -> None:
    persisted = {}
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: persisted.__setitem__(k, v) or True)
    monkeypatch.setattr(audio, "list_sounds", lambda: ["alert.wav", "buzz.wav", "chime.wav"])
    monkeypatch.setattr("app.settings._get_setting_str", lambda k, d: d)
    monkeypatch.setattr("app.settings._get_setting_int", lambda k, d, lo, hi: d)
    r = client.post(
        "/local/audio/config",
        json={
            "error": {"sound_file": "buzz.wav", "enabled": True},
            "alert": {"sound_file": "none", "enabled": False},
            "info": {"sound_file": "chime.wav", "enabled": False},
            "volume_pct": 70,
        },
    )
    assert r.status_code == 200
    assert persisted["audio_sound_error"] == "buzz.wav"
    assert persisted["audio_enable_alert"] == "0"
    assert persisted["audio_volume_pct"] == "70"


def test_audio_config_accepts_overdrive_volume(monkeypatch) -> None:
    persisted = {}
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: persisted.__setitem__(k, v) or True)
    monkeypatch.setattr(audio, "list_sounds", lambda: ["alert.wav"])
    monkeypatch.setattr("app.settings._get_setting_str", lambda k, d: d)
    monkeypatch.setattr("app.settings._get_setting_int", lambda k, d, lo, hi: d)
    base = {
        "error": {"sound_file": "alert.wav", "enabled": True},
        "alert": {"sound_file": "none", "enabled": False},
        "info": {"sound_file": "none", "enabled": False},
    }
    ok = client.post("/local/audio/config", json={**base, "volume_pct": audio.VOLUME_MAX})
    assert ok.status_code == 200 and persisted["audio_volume_pct"] == str(audio.VOLUME_MAX)
    bad = client.post("/local/audio/config", json={**base, "volume_pct": audio.VOLUME_MAX + 1})
    assert bad.status_code == 422  # above the overdrive ceiling


def test_audio_config_post_rejects_unknown_sound(monkeypatch) -> None:
    monkeypatch.setattr(audio, "list_sounds", lambda: ["alert.wav"])
    r = client.post(
        "/local/audio/config",
        json={
            "error": {"sound_file": "does-not-exist.wav", "enabled": True},
            "alert": {"sound_file": "none", "enabled": False},
            "info": {"sound_file": "none", "enabled": False},
            "volume_pct": 80,
        },
    )
    assert r.status_code == 400
