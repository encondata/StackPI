"""probe_reader: scheme detection, reader naming, and error mapping.

Calls probe_reader directly (not via TestClient) so it does not require
python-multipart, which the FastAPI app import pulls in for other routes.
"""
import pytest
from fastapi import HTTPException

from app import rfid_status
from app.rfid import ReaderProbeRequest, probe_reader
from app.rfid_status import ReaderAuthError


def test_probe_returns_detected_scheme(monkeypatch):
    monkeypatch.setattr(rfid_status, "connect_autodetect", lambda reader: ("http", "tok"))
    monkeypatch.setattr(rfid_status, "_get_name_and_description", lambda reader, token: {})
    monkeypatch.setattr(rfid_status, "_get_status", lambda reader, token: {"readerName": "Dock-1"})
    out = probe_reader(ReaderProbeRequest(address="10.0.0.5", password="pw"))
    assert out["ok"] is True
    assert out["scheme"] == "http"
    # No name in nameAndDescription -> fall back to the status name field.
    assert out["hostname"] == "Dock-1"


def test_probe_prefers_name_and_description(monkeypatch):
    monkeypatch.setattr(rfid_status, "connect_autodetect", lambda reader: ("https", "tok"))
    monkeypatch.setattr(rfid_status, "_get_name_and_description", lambda reader, token: {"name": "DockDoor3"})
    monkeypatch.setattr(rfid_status, "_get_status", lambda reader, token: {"readerName": "status-name-ignored"})
    out = probe_reader(ReaderProbeRequest(address="10.0.0.5", password="pw"))
    # nameAndDescription wins over the status name field.
    assert out["hostname"] == "DockDoor3"
    assert out["name_and_description"] == {"name": "DockDoor3"}


def test_probe_strips_model_description_from_name(monkeypatch):
    # The live-reported case: the reader's name field embeds the model
    # description; the cloud keys on the short name only.
    nd = {"name": "FX9600647D23 FX9600 RFID Reader", "description": "FX9600 RFID Reader"}
    monkeypatch.setattr(rfid_status, "connect_autodetect", lambda reader: ("https", "tok"))
    monkeypatch.setattr(rfid_status, "_get_name_and_description", lambda reader, token: nd)
    monkeypatch.setattr(rfid_status, "_get_status", lambda reader, token: {})
    out = probe_reader(ReaderProbeRequest(address="10.10.48.119", password="pw"))
    assert out["hostname"] == "FX9600647D23"


def test_probe_name_fetch_failure_falls_back_to_status(monkeypatch):
    def boom(reader, token):
        raise RuntimeError("nameAndDescription HTTP 404")
    monkeypatch.setattr(rfid_status, "connect_autodetect", lambda reader: ("https", "tok"))
    monkeypatch.setattr(rfid_status, "_get_name_and_description", boom)
    monkeypatch.setattr(rfid_status, "_get_status", lambda reader, token: {"readerName": "Dock-7"})
    out = probe_reader(ReaderProbeRequest(address="10.0.0.5", password="pw"))
    # A nameAndDescription failure must not fail the probe; fall back to status.
    assert out["hostname"] == "Dock-7"


def test_probe_falls_back_to_address_when_no_name(monkeypatch):
    monkeypatch.setattr(rfid_status, "connect_autodetect", lambda reader: ("https", "tok"))
    monkeypatch.setattr(rfid_status, "_get_name_and_description", lambda reader, token: {})
    monkeypatch.setattr(rfid_status, "_get_status", lambda reader, token: {})
    out = probe_reader(ReaderProbeRequest(address="10.0.0.9", password="pw"))
    # No name anywhere -> last-resort fall back to the address.
    assert out["hostname"] == "10.0.0.9"


def test_probe_auth_error_returns_401(monkeypatch):
    def boom(reader):
        raise ReaderAuthError("login HTTP 401")
    monkeypatch.setattr(rfid_status, "connect_autodetect", boom)
    with pytest.raises(HTTPException) as ei:
        probe_reader(ReaderProbeRequest(address="10.0.0.5", password="wrong"))
    assert ei.value.status_code == 401


def test_probe_unreachable_returns_502(monkeypatch):
    def boom(reader):
        raise RuntimeError("could not reach reader over https/http")
    monkeypatch.setattr(rfid_status, "connect_autodetect", boom)
    with pytest.raises(HTTPException) as ei:
        probe_reader(ReaderProbeRequest(address="10.0.0.5", password="pw"))
    assert ei.value.status_code == 502
