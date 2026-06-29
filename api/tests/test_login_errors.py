# api/tests/test_login_errors.py
"""_login maps reader failures to typed exceptions."""
import pytest
import requests

from app import rfid_status
from app.rfid_status import ReaderAuthError, ReaderTransportError, _login


class _Resp:
    def __init__(self, status_code=200, text="JWT Token: a.b.c", headers=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {"content-type": "text/plain"}

    def json(self):
        import json
        return json.loads(self.text)


_READER = {"address": "10.0.0.5", "scheme": "https", "admin_username": "admin", "admin_password": "pw"}


def test_transport_error_maps_to_reader_transport_error(monkeypatch):
    def boom(*a, **k):
        raise requests.exceptions.ConnectionError("refused")
    monkeypatch.setattr(rfid_status.requests, "get", boom)
    with pytest.raises(ReaderTransportError):
        _login(_READER)


def test_tls_handshake_failure_is_transport_error(monkeypatch):
    def boom(*a, **k):
        raise requests.exceptions.SSLError("WRONG_VERSION_NUMBER")
    monkeypatch.setattr(rfid_status.requests, "get", boom)
    with pytest.raises(ReaderTransportError):
        _login(_READER)


def test_http_401_maps_to_auth_error(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(status_code=401, text="unauthorized"))
    with pytest.raises(ReaderAuthError):
        _login(_READER)


def test_http_403_maps_to_auth_error(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(status_code=403, text="forbidden"))
    with pytest.raises(ReaderAuthError):
        _login(_READER)


def test_http_500_maps_to_generic_runtimeerror(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(status_code=500, text="boom"))
    with pytest.raises(RuntimeError) as ei:
        _login(_READER)
    assert not isinstance(ei.value, (ReaderAuthError, ReaderTransportError))


def test_success_returns_jwt(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(status_code=200, text="JWT Token: aa.bb.cc"))
    assert _login(_READER) == "aa.bb.cc"
