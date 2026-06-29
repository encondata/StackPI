"""Zebra reader discovery: signature confirm + scan orchestration."""
import requests

from app import rfid as rfid_mod
from app.rfid import _is_ziotc_reader


class _Resp:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


def test_confirms_on_auth_header_marker(monkeypatch):
    monkeypatch.setattr(rfid_mod.requests, "get",
                        lambda *a, **k: _Resp(500, "Authorization header missing!"))
    assert _is_ziotc_reader("http", "10.0.0.5") is True


def test_confirms_on_jwt_marker(monkeypatch):
    monkeypatch.setattr(rfid_mod.requests, "get",
                        lambda *a, **k: _Resp(401, "Invalid number of segments in jwt token; authorization required"))
    assert _is_ziotc_reader("https", "10.0.0.5") is True


def test_rejects_a_plain_web_page(monkeypatch):
    monkeypatch.setattr(rfid_mod.requests, "get",
                        lambda *a, **k: _Resp(200, "<html><body>Printer admin</body></html>"))
    assert _is_ziotc_reader("http", "10.0.0.5") is False


def test_rejects_on_connection_error(monkeypatch):
    def boom(*a, **k):
        raise requests.exceptions.ConnectionError("refused")
    monkeypatch.setattr(rfid_mod.requests, "get", boom)
    assert _is_ziotc_reader("https", "10.0.0.5") is False


def test_discover_returns_only_confirmed_readers(monkeypatch):
    from app.rfid import discover_readers

    # /30 subnet -> hosts 10.0.0.1, 10.0.0.2
    monkeypatch.setattr(rfid_mod, "_primary_local_cidr", lambda: "10.0.0.0/30")

    open_map = {("10.0.0.1", 443): True, ("10.0.0.1", 80): True, ("10.0.0.2", 80): True}
    monkeypatch.setattr(rfid_mod, "_probe",
                        lambda host, port, timeout: host if open_map.get((host, port)) else None)

    # Only 10.0.0.1 is a real reader, and only over https.
    monkeypatch.setattr(rfid_mod, "_is_ziotc_reader",
                        lambda scheme, ip, timeout=1.0: ip == "10.0.0.1" and scheme == "https")

    out = discover_readers()
    assert out["scanned_count"] == 2
    assert out["readers"] == [
        {"ip": "10.0.0.1", "scheme": "https", "port": 443,
         "name": None, "source": "scan", "confirmed": True}
    ]


def test_discover_prefers_https_when_both_open(monkeypatch):
    from app.rfid import discover_readers
    monkeypatch.setattr(rfid_mod, "_primary_local_cidr", lambda: "10.0.0.0/30")
    monkeypatch.setattr(rfid_mod, "_probe",
                        lambda host, port, timeout: host if host == "10.0.0.1" else None)
    # Confirms on both schemes; dedupe must keep https only.
    monkeypatch.setattr(rfid_mod, "_is_ziotc_reader", lambda scheme, ip, timeout=1.0: ip == "10.0.0.1")
    out = discover_readers()
    assert len(out["readers"]) == 1
    assert out["readers"][0]["scheme"] == "https"
    assert out["readers"][0]["port"] == 443


def test_discover_no_subnet_raises_500(monkeypatch):
    from fastapi import HTTPException
    import pytest
    from app.rfid import discover_readers
    monkeypatch.setattr(rfid_mod, "_primary_local_cidr", lambda: None)
    with pytest.raises(HTTPException) as ei:
        discover_readers()
    assert ei.value.status_code == 500
