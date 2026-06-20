from fastapi.testclient import TestClient

from app.main import app
from app import rfid_status as rs

client = TestClient(app)

SAMPLE_EP = {"data": {"event": {"connections": []}}}
SAMPLE_CONFIG = {"xml": "x", "READER-GATEWAY": {"endpointConfig": SAMPLE_EP}}


# --- _extract_endpoint_config ----------------------------------------------

def test_extract_endpoint_config_found() -> None:
    assert rs._extract_endpoint_config(SAMPLE_CONFIG) == SAMPLE_EP


def test_extract_endpoint_config_missing() -> None:
    assert rs._extract_endpoint_config({"xml": "x"}) is None
    assert rs._extract_endpoint_config({"READER-GATEWAY": {}}) is None
    assert rs._extract_endpoint_config({"READER-GATEWAY": "nope"}) is None


# --- get_endpoint_config (reader I/O mocked) -------------------------------

def test_get_endpoint_config_ok(monkeypatch) -> None:
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: {"id": rid, "address": "10.0.0.5"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")
    monkeypatch.setattr(rs, "_get_config", lambda reader, token: SAMPLE_CONFIG)
    out = rs.get_endpoint_config(3)
    assert out["ok"] is True
    assert out["reader_id"] == 3
    assert out["endpoint_config"] == SAMPLE_EP


def test_get_endpoint_config_none_when_unset(monkeypatch) -> None:
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: {"id": rid, "address": "10.0.0.5"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")
    monkeypatch.setattr(rs, "_get_config", lambda reader, token: {"xml": "x"})
    out = rs.get_endpoint_config(3)
    assert out["ok"] is True
    assert out["endpoint_config"] is None


def test_get_endpoint_config_reader_not_found(monkeypatch) -> None:
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: None)
    assert rs.get_endpoint_config(9) == {
        "ok": False, "reader_id": 9, "error": "reader not found"
    }


def test_get_endpoint_config_transport_error(monkeypatch) -> None:
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: {"id": rid, "address": "10.0.0.5"})

    def boom(reader):
        raise RuntimeError("login transport error: ReadTimeout")

    monkeypatch.setattr(rs, "_login", boom)
    out = rs.get_endpoint_config(3)
    assert out["ok"] is False
    assert "transport error" in out["error"]


# --- put_endpoint_config ----------------------------------------------------

def test_put_endpoint_config_ok(monkeypatch) -> None:
    sent = {}
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: {"id": rid, "address": "10.0.0.5"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")
    monkeypatch.setattr(rs, "_put_cloud_config", lambda reader, token, body: sent.update(body))
    out = rs.put_endpoint_config(2, SAMPLE_EP)
    assert out == {"ok": True, "reader_id": 2}
    # Wrapped in the importCloudConfigReq envelope the reader expects.
    assert sent == {"endpointConfig": SAMPLE_EP}


def test_put_endpoint_config_error(monkeypatch) -> None:
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: {"id": rid, "address": "10.0.0.5"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")

    def boom(reader, token, body):
        raise RuntimeError("cloudConfig HTTP 500: boom")

    monkeypatch.setattr(rs, "_put_cloud_config", boom)
    out = rs.put_endpoint_config(2, SAMPLE_EP)
    assert out["ok"] is False
    assert "HTTP 500" in out["error"]


# --- routes -----------------------------------------------------------------

def test_get_route_200(monkeypatch) -> None:
    monkeypatch.setattr(
        rs, "get_endpoint_config",
        lambda rid: {"ok": True, "reader_id": rid, "endpoint_config": SAMPLE_EP},
    )
    r = client.get("/local/rfid/readers/4/endpoint-config")
    assert r.status_code == 200
    assert r.json()["endpoint_config"] == SAMPLE_EP


def test_get_route_404(monkeypatch) -> None:
    monkeypatch.setattr(
        rs, "get_endpoint_config",
        lambda rid: {"ok": False, "reader_id": rid, "error": "reader not found"},
    )
    assert client.get("/local/rfid/readers/4/endpoint-config").status_code == 404


def test_get_route_502_on_reader_error(monkeypatch) -> None:
    monkeypatch.setattr(
        rs, "get_endpoint_config",
        lambda rid: {"ok": False, "reader_id": rid, "error": "config transport error: X"},
    )
    assert client.get("/local/rfid/readers/4/endpoint-config").status_code == 502


def test_put_route_200(monkeypatch) -> None:
    captured = {}

    def fake_put(rid, ep):
        captured["rid"] = rid
        captured["ep"] = ep
        return {"ok": True, "reader_id": rid}

    monkeypatch.setattr(rs, "put_endpoint_config", fake_put)
    r = client.put("/local/rfid/readers/7/endpoint-config", json={"endpointConfig": SAMPLE_EP})
    assert r.status_code == 200
    assert captured["rid"] == 7
    assert captured["ep"] == SAMPLE_EP


def test_put_route_validation_422() -> None:
    # Missing the required endpointConfig key.
    r = client.put("/local/rfid/readers/7/endpoint-config", json={"nope": 1})
    assert r.status_code == 422


def test_put_route_502_on_reader_error(monkeypatch) -> None:
    monkeypatch.setattr(
        rs, "put_endpoint_config",
        lambda rid, ep: {"ok": False, "reader_id": rid, "error": "cloudConfig HTTP 500: boom"},
    )
    r = client.put("/local/rfid/readers/7/endpoint-config", json={"endpointConfig": SAMPLE_EP})
    assert r.status_code == 502
