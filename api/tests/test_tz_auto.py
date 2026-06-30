"""Geo-IP timezone detection helpers and one-shot apply."""
import requests

from app import tz_auto


class _Resp:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


def test_detect_valid_zone():
    assert tz_auto._detect_timezone(lambda: _Resp(200, "America/Chicago\n")) == "America/Chicago"


def test_detect_http_error_is_none():
    assert tz_auto._detect_timezone(lambda: _Resp(500, "oops")) is None


def test_detect_junk_body_is_none():
    assert tz_auto._detect_timezone(lambda: _Resp(200, "not a zone!!")) is None


def test_detect_request_exception_is_none():
    def boom():
        raise requests.exceptions.ConnectionError("offline")
    assert tz_auto._detect_timezone(boom) is None


def test_should_apply():
    assert tz_auto._should_apply("America/Chicago", "UTC") is True
    assert tz_auto._should_apply("UTC", "UTC") is False
    assert tz_auto._should_apply(None, "UTC") is False


def test_apply_once_applies_on_change(monkeypatch):
    monkeypatch.setattr(tz_auto, "get_timezone_auto", lambda: True)
    monkeypatch.setattr(tz_auto, "_detect_timezone", lambda get_fn: "America/Chicago")
    monkeypatch.setattr(tz_auto, "_current_timezone", lambda: "UTC")
    applied = {}
    monkeypatch.setattr(tz_auto, "_apply", lambda z: applied.setdefault("z", z) or True)
    assert tz_auto.apply_once() == "America/Chicago"
    assert applied["z"] == "America/Chicago"


def test_apply_once_skips_when_disabled(monkeypatch):
    monkeypatch.setattr(tz_auto, "get_timezone_auto", lambda: False)
    called = {"n": 0}
    monkeypatch.setattr(tz_auto, "_detect_timezone", lambda get_fn: called.__setitem__("n", called["n"] + 1) or "X")
    assert tz_auto.apply_once() is None
    assert called["n"] == 0  # geo-IP not queried while overridden


def test_apply_once_reached_but_no_change(monkeypatch):
    monkeypatch.setattr(tz_auto, "get_timezone_auto", lambda: True)
    monkeypatch.setattr(tz_auto, "_detect_timezone", lambda get_fn: "UTC")
    monkeypatch.setattr(tz_auto, "_current_timezone", lambda: "UTC")
    monkeypatch.setattr(tz_auto, "_apply", lambda z: (_ for _ in ()).throw(AssertionError("should not apply")))
    assert tz_auto.apply_once() == "UTC"  # reached service, nothing applied
