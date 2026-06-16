from fastapi.testclient import TestClient

from app.main import app
from app import settings as settings_mod

client = TestClient(app)


def test_connectivity_shape(monkeypatch) -> None:
    monkeypatch.setattr(settings_mod, "_default_gateway", lambda: "10.0.0.1")
    monkeypatch.setattr(settings_mod, "_ping", lambda host, timeout_s=2: host == "10.0.0.1")
    r = client.get("/local/settings/connectivity")
    assert r.status_code == 200
    body = r.json()
    assert body["gateway"] == "10.0.0.1"
    assert body["gateway_ok"] is True
    assert body["internet_ok"] is False
    assert isinstance(body["checked"], list)


def test_wired_manual_rejects_bad_ip(monkeypatch) -> None:
    # Should 400 on validation BEFORE invoking the helper.
    called = {"helper": False}
    monkeypatch.setattr(settings_mod, "_run_helper", lambda *a, **k: called.__setitem__("helper", True) or "")
    r = client.post(
        "/local/settings/wired",
        json={"method": "manual", "static": {"ip": "999.1.1.1", "prefix": 24, "gateway": "192.168.1.1", "dns": []}},
    )
    assert r.status_code == 400
    assert called["helper"] is False


def test_wired_manual_requires_static() -> None:
    r = client.post("/local/settings/wired", json={"method": "manual"})
    assert r.status_code == 400


def test_wired_method_must_be_valid() -> None:
    r = client.post("/local/settings/wired", json={"method": "bridge"})
    assert r.status_code == 422  # pydantic pattern rejection


def test_wired_dhcp_calls_helper(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(settings_mod, "_run_helper", lambda *a, **k: calls.append(a) or "connection=eth0\ndevice=eth0\ncarrier=1\nmethod=auto\naddresses=\ngateway=\ndns=")
    r = client.post("/local/settings/wired", json={"method": "auto"})
    assert r.status_code == 200
    assert ("set-wired-dhcp",) in calls
    assert r.json()["method"] == "auto"


def test_parse_wired_handles_static() -> None:
    out = "connection=Wired connection 1\ndevice=eth0\ncarrier=1\nmethod=manual\naddresses=192.168.1.50/24\ngateway=192.168.1.1\ndns=1.1.1.1,8.8.8.8"
    parsed = settings_mod._parse_wired(out)
    assert parsed["ip"] == "192.168.1.50"
    assert parsed["prefix"] == 24
    assert parsed["gateway"] == "192.168.1.1"
    assert parsed["dns"] == ["1.1.1.1", "8.8.8.8"]
    assert parsed["method"] == "manual"
