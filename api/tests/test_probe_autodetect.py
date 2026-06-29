"""probe_reader returns the detected scheme and maps auth errors to 401.

Calls probe_reader directly (not via TestClient) so it does not require
python-multipart, which the FastAPI app import pulls in for other routes.
"""
import pytest
from fastapi import HTTPException

from app import rfid as rfid_mod
from app import rfid_status
from app.rfid import ReaderProbeRequest, probe_reader
from app.rfid_status import ReaderAuthError


def test_probe_returns_detected_scheme(monkeypatch):
    monkeypatch.setattr(rfid_status, "connect_autodetect", lambda reader: ("http", "tok"))
    monkeypatch.setattr(rfid_status, "_get_status", lambda reader, token: {"readerName": "Dock-1"})
    body = ReaderProbeRequest(address="10.0.0.5", password="pw")
    out = probe_reader(body)
    assert out["ok"] is True
    assert out["scheme"] == "http"
    assert out["hostname"] == "Dock-1"


def test_probe_auth_error_returns_401(monkeypatch):
    def boom(reader):
        raise ReaderAuthError("login HTTP 401")
    monkeypatch.setattr(rfid_status, "connect_autodetect", boom)
    body = ReaderProbeRequest(address="10.0.0.5", password="wrong")
    with pytest.raises(HTTPException) as ei:
        probe_reader(body)
    assert ei.value.status_code == 401


def test_probe_unreachable_returns_502(monkeypatch):
    def boom(reader):
        raise RuntimeError("could not reach reader over https/http")
    monkeypatch.setattr(rfid_status, "connect_autodetect", boom)
    body = ReaderProbeRequest(address="10.0.0.5", password="pw")
    with pytest.raises(HTTPException) as ei:
        probe_reader(body)
    assert ei.value.status_code == 502
