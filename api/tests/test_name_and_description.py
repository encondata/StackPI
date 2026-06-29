"""_get_name_and_description GETs /cloud/nameAndDescription and returns a dict."""
import pytest

from app import rfid_status
from app.rfid_status import _get_name_and_description

_READER = {"address": "10.0.0.5", "scheme": "https", "admin_username": "admin", "admin_password": "pw"}


class _Resp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def test_success_returns_dict(monkeypatch):
    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        return _Resp(payload={"name": "DockDoor3", "description": "north dock"})

    monkeypatch.setattr(rfid_status.requests, "get", fake_get)
    out = _get_name_and_description(_READER, "tok")
    assert out == {"name": "DockDoor3", "description": "north dock"}
    assert captured["url"].endswith("/cloud/nameAndDescription")


def test_non_200_raises(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(status_code=404, text="nope"))
    with pytest.raises(RuntimeError):
        _get_name_and_description(_READER, "tok")


def test_non_dict_payload_raises(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(payload=["a", "b"]))
    with pytest.raises(RuntimeError):
        _get_name_and_description(_READER, "tok")
