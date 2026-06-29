"""connect_autodetect tries https then http, with the locked fallback rules."""
import pytest

from app import rfid_status
from app.rfid_status import ReaderAuthError, ReaderTransportError, connect_autodetect

_READER = {"address": "10.0.0.5", "admin_username": "admin", "admin_password": "pw"}


def _fake_login(results):
    """results: dict scheme -> token string or exception instance to raise."""
    calls = []

    def _login(reader):
        scheme = reader["scheme"]
        calls.append(scheme)
        outcome = results[scheme]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    _login.calls = calls
    return _login


def test_https_success_returns_https_and_skips_http(monkeypatch):
    fake = _fake_login({"https": "tok-https"})
    monkeypatch.setattr(rfid_status, "_login", fake)
    assert connect_autodetect(_READER) == ("https", "tok-https")
    assert fake.calls == ["https"]


def test_https_transport_error_falls_back_to_http(monkeypatch):
    fake = _fake_login({"https": ReaderTransportError("refused"), "http": "tok-http"})
    monkeypatch.setattr(rfid_status, "_login", fake)
    assert connect_autodetect(_READER) == ("http", "tok-http")
    assert fake.calls == ["https", "http"]


def test_https_auth_error_does_not_fall_back(monkeypatch):
    fake = _fake_login({"https": ReaderAuthError("401")})
    monkeypatch.setattr(rfid_status, "_login", fake)
    with pytest.raises(ReaderAuthError):
        connect_autodetect(_READER)
    assert fake.calls == ["https"]  # http never tried


def test_https_generic_error_does_not_fall_back(monkeypatch):
    fake = _fake_login({"https": RuntimeError("500")})
    monkeypatch.setattr(rfid_status, "_login", fake)
    with pytest.raises(RuntimeError):
        connect_autodetect(_READER)
    assert fake.calls == ["https"]


def test_both_transport_errors_raise_runtimeerror(monkeypatch):
    fake = _fake_login({"https": ReaderTransportError("a"), "http": ReaderTransportError("b")})
    monkeypatch.setattr(rfid_status, "_login", fake)
    with pytest.raises(RuntimeError):
        connect_autodetect(_READER)
    assert fake.calls == ["https", "http"]
