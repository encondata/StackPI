"""Tests for the kiosk home RFID Reader card's backend.

Covers the pure state-derivation helper and the GET /local/rfid/active-reader
endpoint. The DB is fully monkeypatched — no live postgres or reader needed.
The endpoint reads the active-reader name via app.settings._get_setting_str
and the reader row via app.rfid._psql_json; we patch both.
"""
from fastapi.testclient import TestClient

from app.main import app
from app import rfid as rfid_mod
from app import settings as settings_mod

client = TestClient(app)


# --- pure state derivation -------------------------------------------------

# A reachable reader with all output connectors connected.
_CONNECTED = {"interfaceConnectionStatus": {"data": [{"connectionStatus": "connected"}]}}
_DISCONNECTED = {"interfaceConnectionStatus": {"data": [{"connectionStatus": "disconnected"}]}}


def test_derive_offline_on_error():
    assert rfid_mod._derive_reader_state("login transport error", None) == "offline"
    assert rfid_mod._derive_reader_state("boom", {"radioActivity": "active"}) == "offline"


def test_derive_offline_when_no_status():
    assert rfid_mod._derive_reader_state(None, None) == "offline"
    assert rfid_mod._derive_reader_state(None, "not-a-dict") == "offline"


def test_derive_reading_when_connected_and_radio_active():
    assert rfid_mod._derive_reader_state(None, {**_CONNECTED, "radioActivity": "active"}) == "reading"
    # Tolerate the known firmware typo + case.
    assert rfid_mod._derive_reader_state(None, {**_CONNECTED, "radioActivitiy": "ACTIVE"}) == "reading"


def test_derive_online_when_connected_not_reading():
    assert rfid_mod._derive_reader_state(None, {**_CONNECTED, "radioActivity": "inactive"}) == "online"
    assert rfid_mod._derive_reader_state(None, _CONNECTED) == "online"


def test_derive_degraded_when_connector_down_or_unknown():
    # No connector info at all → can't confirm connectivity → yellow.
    assert rfid_mod._derive_reader_state(None, {"radioActivity": "inactive"}) == "degraded"
    assert rfid_mod._derive_reader_state(None, {}) == "degraded"
    # A non-connected connector → yellow.
    assert rfid_mod._derive_reader_state(None, _DISCONNECTED) == "degraded"
    # Yellow wins over green: reading but a connector is down.
    assert rfid_mod._derive_reader_state(None, {**_DISCONNECTED, "radioActivity": "active"}) == "degraded"


# --- GET /local/rfid/active-reader -----------------------------------------

def test_active_reader_unconfigured(monkeypatch):
    monkeypatch.setattr(settings_mod, "_get_setting_str", lambda key, default: "")
    r = client.get("/local/rfid/active-reader")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is False
    assert body["state"] == "unconfigured"


def test_active_reader_name_no_longer_matches(monkeypatch):
    monkeypatch.setattr(settings_mod, "_get_setting_str", lambda key, default: "Ghost-Reader")
    monkeypatch.setattr(rfid_mod, "_psql_json", lambda sql: [])
    r = client.get("/local/rfid/active-reader")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is False
    assert body["state"] == "unconfigured"
    assert body["name"] == "Ghost-Reader"


def test_active_reader_reading(monkeypatch):
    monkeypatch.setattr(settings_mod, "_get_setting_str", lambda key, default: "FX-1")
    monkeypatch.setattr(
        rfid_mod, "_psql_json",
        lambda sql: [{
            "id": 3, "name": "FX-1", "enabled": True,
            "last_error": None,
            "last_status": {
                "radioActivity": "active",
                "interfaceConnectionStatus": {"data": [{"connectionStatus": "connected"}]},
            },
            "last_status_at": "2026-06-17T00:00:00+00:00",
        }],
    )
    r = client.get("/local/rfid/active-reader")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["reader_id"] == 3
    assert body["name"] == "FX-1"
    assert body["state"] == "reading"


def test_active_reader_offline(monkeypatch):
    monkeypatch.setattr(settings_mod, "_get_setting_str", lambda key, default: "FX-1")
    monkeypatch.setattr(
        rfid_mod, "_psql_json",
        lambda sql: [{
            "id": 3, "name": "FX-1", "enabled": True,
            "last_error": "status HTTP 503",
            "last_status": None,
            "last_status_at": None,
        }],
    )
    r = client.get("/local/rfid/active-reader")
    assert r.status_code == 200
    assert r.json()["state"] == "offline"
