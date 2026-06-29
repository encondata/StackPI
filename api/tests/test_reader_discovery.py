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
