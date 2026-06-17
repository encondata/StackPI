"""Tests for the Initial Setup wizard's device-side endpoints.

Network is fully monkeypatched here: no live BaseCamp portal and no live
Zebra reader are required. The setup proxy tests patch `_basecamp` (or
`_get_access_token`) on the setup module; the probe tests patch the
`rfid_status` login/status helpers the probe handler calls.
"""
from fastapi.testclient import TestClient

from app.main import app
from app import setup as setup_mod
from app import settings as settings_mod
from app import rfid_status

client = TestClient(app)


def test_scan_types_proxy(monkeypatch):
    monkeypatch.setattr(
        setup_mod, "_basecamp",
        lambda m, p, j=None: {"scan_types": [{"id": 1, "name": "RFID Outbound", "color": "#0f0"}]},
    )
    r = client.get("/local/setup/scan-types")
    assert r.status_code == 200
    assert r.json()["scan_types"][0]["name"] == "RFID Outbound"


def test_move_locations_requires_move_id():
    r = client.get("/local/setup/move-locations")
    assert r.status_code == 422  # missing required query param


def test_reader_settings_validates_body():
    r = client.post(
        "/local/setup/reader-settings",
        json={"reader_name": "", "site_id": 1, "scan_type_id": 2},
    )
    assert r.status_code == 422


def test_reader_settings_proxies(monkeypatch):
    captured = {}

    def fake(method, path, json_body=None):
        captured["args"] = (method, path, json_body)
        return {"success": True}

    monkeypatch.setattr(setup_mod, "_basecamp", fake)
    # Intercept the active-reader persistence so the test never writes to the
    # real local_app_settings; also assert the committed reader is recorded.
    persisted = {}

    def fake_persist(key, value):
        persisted[key] = value
        return True

    monkeypatch.setattr(settings_mod, "_persist_setting", fake_persist)
    r = client.post(
        "/local/setup/reader-settings",
        json={"reader_name": "FX-1", "site_id": 10, "scan_type_id": 42},
    )
    assert r.status_code == 200
    assert captured["args"][0] == "PATCH"
    assert captured["args"][1] == "/stackpi/rfid/reader-settings"
    assert captured["args"][2] == {"reader_name": "FX-1", "site_id": 10, "scan_type_id": 42}
    # New behavior: the committed reader becomes the kiosk's active reader.
    assert persisted.get(setup_mod.ACTIVE_READER_NAME_KEY) == "FX-1"


def test_no_token_returns_409(monkeypatch):
    monkeypatch.setattr(setup_mod, "_get_access_token", lambda: (None, "https://x"))
    r = client.get("/local/setup/scan-types")
    assert r.status_code == 409


def test_probe_extracts_hostname(monkeypatch):
    monkeypatch.setattr(rfid_status, "_login", lambda reader: "tok")
    monkeypatch.setattr(rfid_status, "_get_status", lambda reader, token: {"hostName": "FX9600-DOCK1", "x": 1})
    r = client.post("/local/rfid/readers/probe", json={"address": "10.0.0.5", "password": "pw"})
    assert r.status_code == 200
    assert r.json()["hostname"] == "FX9600-DOCK1"


def test_probe_unreachable_returns_502(monkeypatch):
    def boom(reader):
        raise RuntimeError("login transport error")

    monkeypatch.setattr(rfid_status, "_login", boom)
    r = client.post("/local/rfid/readers/probe", json={"address": "10.0.0.5", "password": "pw"})
    assert r.status_code == 502
