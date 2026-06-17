from datetime import datetime, timezone, timedelta

from fastapi.testclient import TestClient

from app.main import app
from app import cloud_status

client = TestClient(app)


def _iso(dt):
    return dt.isoformat()


def test_unregistered_when_no_state():
    assert cloud_status.compute_status({}) == {"connectivity": "online", "display_status": "unregistered"}


def test_registered_online_when_engine_online():
    r = cloud_status.compute_status({"status": "registered", "online": True})
    assert r == {"connectivity": "online", "display_status": "registered"}


def test_offline_when_engine_offline_and_no_recent_ok(monkeypatch):
    # No last_cloud_ok and no heartbeat_ok -> offline
    monkeypatch.setattr("app.settings._get_setting_str", lambda k, d: "")
    monkeypatch.setattr("app.settings._get_setting_int", lambda k, d, lo, hi: 30)
    r = cloud_status.compute_status({"status": "registered", "online": False})
    assert r == {"connectivity": "offline", "display_status": "offline"}


def test_heartbeat_ok_rescues_offline(monkeypatch):
    # Engine flag is False, but a recent heartbeat_ok_at in state keeps it online.
    monkeypatch.setattr("app.settings._get_setting_str", lambda k, d: "")
    monkeypatch.setattr("app.settings._get_setting_int", lambda k, d, lo, hi: 30)
    recent = _iso(datetime.now(timezone.utc) - timedelta(seconds=5))
    r = cloud_status.compute_status(
        {"status": "registered", "online": False, "heartbeat_ok_at": recent}
    )
    assert r == {"connectivity": "online", "display_status": "registered"}


def test_stale_cloud_ok_stays_offline(monkeypatch):
    # A last_cloud_ok_at older than the window does NOT rescue → still offline.
    monkeypatch.setattr("app.settings._get_setting_int", lambda k, d, lo, hi: 30)
    stale = _iso(datetime.now(timezone.utc) - timedelta(seconds=600))  # > max(90, 90)
    monkeypatch.setattr("app.settings._get_setting_str", lambda k, d: stale)
    r = cloud_status.compute_status({"status": "registered", "online": False})
    assert r == {"connectivity": "offline", "display_status": "offline"}


def test_not_registered_is_unregistered_even_when_offline(monkeypatch):
    # Offline evidence must not override the unregistered display state.
    monkeypatch.setattr("app.settings._get_setting_str", lambda k, d: "")
    monkeypatch.setattr("app.settings._get_setting_int", lambda k, d, lo, hi: 30)
    r = cloud_status.compute_status({"status": "revoked", "online": False})
    assert r["display_status"] == "unregistered"
    assert r["connectivity"] == "offline"


def test_recent_cloud_ok_rescues_offline(monkeypatch):
    recent = _iso(datetime.now(timezone.utc) - timedelta(seconds=5))
    monkeypatch.setattr("app.settings._get_setting_str", lambda k, d: recent)
    monkeypatch.setattr("app.settings._get_setting_int", lambda k, d, lo, hi: 30)
    r = cloud_status.compute_status({"status": "registered", "online": False})
    assert r["display_status"] == "registered"  # recent api success keeps it online


def test_status_endpoint_includes_display_status():
    r = client.get("/local/status")
    assert r.status_code == 200
    body = r.json()
    assert "display_status" in body and "connectivity" in body


def test_device_status_interval_bounds():
    assert client.post("/local/settings/device-status", json={"interval_seconds": 5}).status_code == 422
    assert client.post("/local/settings/device-status", json={"interval_seconds": 999}).status_code == 422
    r = client.get("/local/settings/device-status")
    assert r.status_code == 200
    assert r.json()["interval_seconds_default"] == 30
