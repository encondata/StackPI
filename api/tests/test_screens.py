"""Tests for screen config: cycle-seconds endpoint and the touchscreen now
accepting a screen assignment. DB is monkeypatched — no live postgres needed.
"""
from fastapi.testclient import TestClient

from app.main import app
from app import screens as screens_mod
from app import settings as settings_mod

client = TestClient(app)


def test_cycle_seconds_get(monkeypatch):
    monkeypatch.setattr(settings_mod, "_get_setting_int", lambda k, d, lo, hi: 20)
    r = client.get("/local/screens/cycle-seconds")
    assert r.status_code == 200
    b = r.json()
    assert b["cycle_seconds"] == 20
    assert b["cycle_seconds_min"] == screens_mod.CYCLE_MIN
    assert b["cycle_seconds_max"] == screens_mod.CYCLE_MAX


def test_cycle_seconds_post_clamps(monkeypatch):
    saved = {}
    monkeypatch.setattr(settings_mod, "_persist_setting", lambda k, v: saved.__setitem__(k, v) or True)
    monkeypatch.setattr(settings_mod, "_get_setting_int", lambda k, d, lo, hi: int(saved.get(k, d)))

    # Above max → clamped to CYCLE_MAX.
    r = client.post("/local/screens/cycle-seconds", json={"cycle_seconds": 99999})
    assert r.status_code == 200
    assert saved[screens_mod.SCREEN_CYCLE_KEY] == str(screens_mod.CYCLE_MAX)

    # Below min → clamped to CYCLE_MIN.
    r = client.post("/local/screens/cycle-seconds", json={"cycle_seconds": 1})
    assert r.status_code == 200
    assert saved[screens_mod.SCREEN_CYCLE_KEY] == str(screens_mod.CYCLE_MIN)


def test_cycle_seconds_post_rejects_non_int():
    # A non-int value is rejected — by pydantic (422) for a bad type, or by the
    # handler's own guard (400) for a missing/None value. Either is a 4xx.
    r = client.post("/local/screens/cycle-seconds", json={"cycle_seconds": "soon"})
    assert r.status_code in (400, 422)


def test_cycle_seconds_post_missing_key_400():
    # Empty body → the handler's own guard returns 400 (covers the int(None) path).
    r = client.post("/local/screens/cycle-seconds", json={})
    assert r.status_code == 400


def test_touch_accepts_default_screen(monkeypatch):
    monkeypatch.setattr(screens_mod, "_psql_exec", lambda sql: True)
    monkeypatch.setattr(screens_mod, "_psql_rows", lambda sql: [])
    r = client.post("/local/screens/touch", json={"default_screen": "status", "selector": "status"})
    assert r.status_code == 200


def test_touch_rejects_info_only_key():
    # 'saver' is an info-screen key; the touchscreen must still reject it.
    r = client.post("/local/screens/touch", json={"saver": "15m"})
    assert r.status_code == 400


def test_screen_rejects_invalid_value(monkeypatch):
    r = client.post("/local/screens/info1", json={"default_screen": "bogus"})
    assert r.status_code == 400
