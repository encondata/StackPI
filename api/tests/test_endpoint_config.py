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

def test_put_endpoint_config_read_modify_write(monkeypatch) -> None:
    # Read-modify-write: splice endpointConfig into the live config and PUT the
    # WHOLE thing back (the reader has no /cloud/cloudConfig on 3.29.x firmware),
    # preserving every other setting.
    existing = {
        "xml": "x",
        "GPIO-LED": {"a": 1},
        "READER-GATEWAY": {
            "retention": {"throttle": 200},
            "endpointConfig": {"old": True},
        },
    }
    sent = {}
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: {"id": rid, "address": "10.0.0.5"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")
    monkeypatch.setattr(rs, "_get_config", lambda reader, token: existing)
    monkeypatch.setattr(rs, "_put_config", lambda reader, token, cfg: sent.update(cfg))

    out = rs.put_endpoint_config(2, SAMPLE_EP)
    assert out == {"ok": True, "reader_id": 2}
    # endpointConfig replaced...
    assert sent["READER-GATEWAY"]["endpointConfig"] == SAMPLE_EP
    # ...and everything else preserved.
    assert sent["xml"] == "x"
    assert sent["GPIO-LED"] == {"a": 1}
    assert sent["READER-GATEWAY"]["retention"] == {"throttle": 200}


def test_put_endpoint_config_creates_gateway_when_missing(monkeypatch) -> None:
    sent = {}
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: {"id": rid, "address": "10.0.0.5"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")
    monkeypatch.setattr(rs, "_get_config", lambda reader, token: {"xml": "x"})
    monkeypatch.setattr(rs, "_put_config", lambda reader, token, cfg: sent.update(cfg))

    out = rs.put_endpoint_config(2, SAMPLE_EP)
    assert out["ok"] is True
    assert sent["READER-GATEWAY"]["endpointConfig"] == SAMPLE_EP


def test_put_endpoint_config_error(monkeypatch) -> None:
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: {"id": rid, "address": "10.0.0.5"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")
    monkeypatch.setattr(rs, "_get_config", lambda reader, token: {"READER-GATEWAY": {}})

    def boom(reader, token, cfg):
        raise RuntimeError("config HTTP 500: boom")

    monkeypatch.setattr(rs, "_put_config", boom)
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
        lambda rid, ep: {"ok": False, "reader_id": rid, "error": "config HTTP 500: boom"},
    )
    r = client.put("/local/rfid/readers/7/endpoint-config", json={"endpointConfig": SAMPLE_EP})
    assert r.status_code == 502


# --- _apply_endpoint_url (pure mutator) ------------------------------------

URL = "http://10.0.0.9:8000/rfid-tags"


def _conns(config):
    return config["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"]


def test_apply_url_updates_existing_httppost() -> None:
    config = {
        "xml": "x",
        "READER-GATEWAY": {
            "retention": {"throttle": 1},
            "endpointConfig": {
                "data": {
                    "event": {
                        "connections": [
                            {"type": "httpPost", "name": "StackPI",
                             "options": {"URL": "http://old:8000/rfid-tags", "security": {"x": 1}}}
                        ]
                    }
                }
            },
        },
    }
    rs._apply_endpoint_url(config, URL)
    conns = _conns(config)
    assert len(conns) == 1
    assert conns[0]["options"]["URL"] == URL
    # untouched siblings preserved
    assert conns[0]["options"]["security"] == {"x": 1}
    assert config["xml"] == "x"
    assert config["READER-GATEWAY"]["retention"] == {"throttle": 1}


def test_apply_url_creates_connection_from_template() -> None:
    config = {"READER-GATEWAY": {"endpointConfig": {"data": {"event": {"connections": []}}}}}
    rs._apply_endpoint_url(config, URL)
    conns = _conns(config)
    assert len(conns) == 1
    assert conns[0]["type"] == "httpPost"
    assert conns[0]["name"] == "StackPI"
    assert conns[0]["options"]["URL"] == URL
    assert conns[0]["options"]["security"]["authenticationType"] == "NONE"


def test_apply_url_builds_nesting_from_empty() -> None:
    config = {}
    rs._apply_endpoint_url(config, URL)
    assert _conns(config)[0]["options"]["URL"] == URL


def test_apply_url_preserves_other_connections() -> None:
    config = {
        "READER-GATEWAY": {
            "endpointConfig": {
                "data": {
                    "event": {
                        "connections": [
                            {"type": "mqtt", "name": "Cloud", "options": {"endpoint": {"hostName": "broker"}}},
                            {"type": "httpPost", "name": "StackPI", "options": {"URL": "http://old/rfid-tags"}},
                        ]
                    }
                }
            }
        }
    }
    rs._apply_endpoint_url(config, URL)
    conns = _conns(config)
    assert len(conns) == 2
    assert conns[0]["type"] == "mqtt"  # untouched
    assert conns[1]["options"]["URL"] == URL


# --- set_endpoint_url + route ----------------------------------------------

def test_set_endpoint_url_ok(monkeypatch) -> None:
    sent = {}
    monkeypatch.setattr(rs, "_get_reader_row", lambda rid: {"id": rid, "address": "10.0.0.5"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")
    monkeypatch.setattr(rs, "_get_config", lambda reader, token: {"READER-GATEWAY": {"endpointConfig": {}}})
    monkeypatch.setattr(rs, "_put_config", lambda reader, token, cfg: sent.update(cfg))
    out = rs.set_endpoint_url(5, URL)
    assert out == {"ok": True, "reader_id": 5, "url": URL}
    assert _conns(sent)[0]["options"]["URL"] == URL


def test_set_endpoint_url_route_200(monkeypatch) -> None:
    captured = {}

    def fake(rid, url):
        captured["rid"] = rid
        captured["url"] = url
        return {"ok": True, "reader_id": rid, "url": url}

    monkeypatch.setattr(rs, "set_endpoint_url", fake)
    r = client.post("/local/rfid/readers/3/endpoint-url", json={"url": URL})
    assert r.status_code == 200
    assert captured == {"rid": 3, "url": URL}


def test_set_endpoint_url_route_422_missing_url() -> None:
    assert client.post("/local/rfid/readers/3/endpoint-url", json={}).status_code == 422


def test_set_endpoint_url_route_502(monkeypatch) -> None:
    monkeypatch.setattr(
        rs, "set_endpoint_url",
        lambda rid, url: {"ok": False, "reader_id": rid, "error": "config transport error"},
    )
    r = client.post("/local/rfid/readers/3/endpoint-url", json={"url": URL})
    assert r.status_code == 502
