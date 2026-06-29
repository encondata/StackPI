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
    monkeypatch.setattr(rfid_mod, "_enrich_reader_name", lambda scheme, ip: (None, None))

    out = discover_readers()
    assert out["scanned_count"] == 2
    assert out["readers"] == [
        {"ip": "10.0.0.1", "scheme": "https", "port": 443,
         "name": None, "source": "scan", "confirmed": True, "cred_index": None}
    ]


def test_discover_prefers_https_when_both_open(monkeypatch):
    from app.rfid import discover_readers
    monkeypatch.setattr(rfid_mod, "_primary_local_cidr", lambda: "10.0.0.0/30")
    monkeypatch.setattr(rfid_mod, "_probe",
                        lambda host, port, timeout: host if host == "10.0.0.1" else None)
    # Confirms on both schemes; dedupe must keep https only.
    monkeypatch.setattr(rfid_mod, "_is_ziotc_reader", lambda scheme, ip, timeout=1.0: ip == "10.0.0.1")
    monkeypatch.setattr(rfid_mod, "_enrich_reader_name", lambda scheme, ip: (None, None))
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


from app import rfid_status


def test_enrich_first_success_returns_index_and_name(monkeypatch):
    from app.rfid import _enrich_reader_name
    tried = []

    def fake_login(reader):
        tried.append(reader["admin_password"])
        if reader["admin_password"] == "Cumulu$SG.":
            return "tok"
        raise RuntimeError("bad password")

    monkeypatch.setattr(rfid_status, "_login", fake_login)
    monkeypatch.setattr(rfid_status, "_get_name_and_description",
                        lambda reader, token: {"name": "FX9600647D23 FX9600 RFID Reader",
                                               "description": "FX9600 RFID Reader"})
    name, idx = _enrich_reader_name("https", "10.0.0.5")
    assert (name, idx) == ("FX9600647D23", 1)
    assert tried == ["Cumulu$SG0", "Cumulu$SG."]  # stopped at first success


def test_enrich_no_password_works(monkeypatch):
    from app.rfid import _enrich_reader_name

    def fail(reader):
        raise RuntimeError("bad password")

    monkeypatch.setattr(rfid_status, "_login", fail)
    assert _enrich_reader_name("https", "10.0.0.5") == (None, None)


def test_enrich_login_ok_but_name_fetch_fails(monkeypatch):
    from app.rfid import _enrich_reader_name
    monkeypatch.setattr(rfid_status, "_login", lambda reader: "tok")

    def boom(reader, token):
        raise RuntimeError("nd 500")

    monkeypatch.setattr(rfid_status, "_get_name_and_description", boom)
    name, idx = _enrich_reader_name("https", "10.0.0.5")
    assert name is None and idx == 0


def test_discover_includes_name_and_cred_index(monkeypatch):
    from app.rfid import discover_readers
    monkeypatch.setattr(rfid_mod, "_primary_local_cidr", lambda: "10.0.0.0/30")
    monkeypatch.setattr(rfid_mod, "_probe",
                        lambda h, p, t: h if (h == "10.0.0.1" and p == 443) else None)
    monkeypatch.setattr(rfid_mod, "_is_ziotc_reader",
                        lambda scheme, ip, timeout=1.0: scheme == "https")
    monkeypatch.setattr(rfid_mod, "_enrich_reader_name", lambda scheme, ip: ("FX9600X", 0))
    out = discover_readers()
    assert out["readers"] == [
        {"ip": "10.0.0.1", "scheme": "https", "port": 443, "name": "FX9600X",
         "source": "scan", "confirmed": True, "cred_index": 0}
    ]


def test_adopt_creates_reader_from_cred_index(monkeypatch):
    from app.rfid import adopt_reader, AdoptReaderRequest
    monkeypatch.setattr(rfid_status, "_login", lambda reader: "tok")
    monkeypatch.setattr(rfid_status, "_get_name_and_description",
                        lambda reader, token: {"name": "FX9600647D23",
                                               "description": "FX9600 RFID Reader"})
    captured = {}

    def fake_create(body):
        captured["body"] = body
        return {"readers": [{"name": body.name}], "counts": {}}

    monkeypatch.setattr(rfid_mod, "create_reader", fake_create)
    out = adopt_reader(AdoptReaderRequest(address="10.10.48.119", scheme="https", cred_index=0))
    assert captured["body"].name == "FX9600647D23"
    assert captured["body"].admin_password == "Cumulu$SG0"
    assert captured["body"].scheme == "https"
    assert out["readers"][0]["name"] == "FX9600647D23"


def test_adopt_out_of_range_cred_index_400(monkeypatch):
    import pytest
    from fastapi import HTTPException
    from app.rfid import adopt_reader, AdoptReaderRequest
    with pytest.raises(HTTPException) as ei:
        adopt_reader(AdoptReaderRequest(address="10.0.0.5", scheme="https", cred_index=99))
    assert ei.value.status_code == 400


def test_adopt_login_failure_502(monkeypatch):
    import pytest
    from fastapi import HTTPException
    from app.rfid import adopt_reader, AdoptReaderRequest

    def boom(reader):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(rfid_status, "_login", boom)
    with pytest.raises(HTTPException) as ei:
        adopt_reader(AdoptReaderRequest(address="10.0.0.5", scheme="https", cred_index=0))
    assert ei.value.status_code == 502
