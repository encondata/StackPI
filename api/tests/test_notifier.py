import json

from fastapi.testclient import TestClient

from app.main import app
from app import notifier as nf

client = TestClient(app)

LIGHT = {
    "pattern": "flash",
    "color": "red",
    "brightness": 80,
    "duration": 500,
    "repeat_count": 3,
}
SOUND = {"sound": "alert", "volume": 70, "duration": 400, "repeat_count": 2}


# --- payload shape ----------------------------------------------------------

def test_light_payload_shape() -> None:
    p = nf._light_payload(nf.LightMessage(**LIGHT))
    assert p == {"v": 1, "type": "light", **LIGHT}


def test_sound_payload_shape() -> None:
    p = nf._sound_payload(nf.SoundMessage(**SOUND))
    assert p == {"v": 1, "type": "sound", **SOUND}


# --- enable gating ----------------------------------------------------------

def test_send_light_respects_enable(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(nf, "_emit", lambda p, g=None, port=None: calls.append(p) or True)

    monkeypatch.setattr(nf, "_enabled", lambda: False)
    assert nf.send_light(nf.LightMessage(**LIGHT)) is False
    assert calls == []  # disabled → not emitted

    monkeypatch.setattr(nf, "_enabled", lambda: True)
    assert nf.send_light(nf.LightMessage(**LIGHT)) is True
    assert calls and calls[0]["type"] == "light"  # (p, group, port) — p captured


def test_reader_light_message_mapping() -> None:
    for state, color in [("offline", "red"), ("degraded", "yellow"),
                         ("reading", "green"), ("online", "blue")]:
        m = nf.reader_light_message(state)
        assert m.pattern == "solid" and m.color == color and m.brightness == 80
    # unconfigured / unknown / None → off (solid, brightness 0)
    assert nf.reader_light_message("unconfigured").brightness == 0
    assert nf.reader_light_message(None).brightness == 0


def test_send_reader_light_gating(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(nf, "_emit", lambda p, g=None, port=None: calls.append(p) or True)
    monkeypatch.setattr(nf, "_enabled", lambda: True)
    monkeypatch.setattr(nf, "_reader_light_enabled", lambda: True)
    assert nf.send_reader_light("offline") is True
    assert calls and calls[0]["type"] == "light" and calls[0]["color"] == "red"
    # reader-light toggle off → no send
    calls.clear()
    monkeypatch.setattr(nf, "_reader_light_enabled", lambda: False)
    assert nf.send_reader_light("offline") is False and calls == []
    # master notify off → no send even if reader-light on
    monkeypatch.setattr(nf, "_reader_light_enabled", lambda: True)
    monkeypatch.setattr(nf, "_enabled", lambda: False)
    assert nf.send_reader_light("offline") is False and calls == []


# --- transport (_emit) ------------------------------------------------------

class _FakeSock:
    last = None

    def __init__(self, *a, **k):
        pass

    def setsockopt(self, *a):
        pass

    def sendto(self, data, addr):
        _FakeSock.last = (data, addr)

    def close(self):
        pass


def test_emit_sends_multicast_datagram(monkeypatch) -> None:
    monkeypatch.setattr(nf.socket, "socket", _FakeSock)

    payload = {"v": 1, "type": "light", "color": "red"}
    assert nf._emit(payload, "239.1.2.3", 5005) is True
    data, addr = _FakeSock.last
    assert addr == ("239.1.2.3", 5005)
    assert json.loads(data.decode()) == payload


def test_emit_swallows_errors(monkeypatch) -> None:
    def boom(*a, **k):
        raise OSError("no network")

    monkeypatch.setattr(nf.socket, "socket", boom)
    assert nf._emit({"x": 1}, "239.1.2.3", 5005) is False  # never raises


# --- test endpoints ---------------------------------------------------------

def test_test_light_endpoint(monkeypatch) -> None:
    captured = {}
    monkeypatch.setattr(nf, "_emit", lambda p, g=None, port=None: captured.update(p) or True)
    r = client.post("/local/notify/test/light", json=LIGHT)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["sent"] == {"v": 1, "type": "light", **LIGHT}
    assert captured["color"] == "red"


def test_test_sound_endpoint(monkeypatch) -> None:
    monkeypatch.setattr(nf, "_emit", lambda p, g=None, port=None: True)
    r = client.post("/local/notify/test/sound", json=SOUND)
    assert r.status_code == 200
    assert r.json()["sent"]["type"] == "sound"


def test_test_light_validation_422() -> None:
    bad = {**LIGHT, "brightness": 150}  # out of range
    assert client.post("/local/notify/test/light", json=bad).status_code == 422
    bad2 = {**LIGHT, "color": "purple"}  # not an allowed color
    assert client.post("/local/notify/test/light", json=bad2).status_code == 422


# --- config endpoints -------------------------------------------------------

def test_get_config_shape(monkeypatch) -> None:
    monkeypatch.setattr(nf, "_get_int", lambda k, d, lo, hi: 5005 if k == nf.KEY_PORT else 1)
    monkeypatch.setattr(nf, "_get_str", lambda k, d: "239.10.10.10")
    body = client.get("/local/notify/config").json()
    assert body["multicast_group"] == "239.10.10.10"
    assert body["multicast_port"] == 5005
    assert body["enabled"] is True


def test_set_config_rejects_non_multicast(monkeypatch) -> None:
    persisted = []
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: persisted.append((k, v)) or True)
    r = client.post(
        "/local/notify/config",
        json={"enabled": True, "multicast_group": "10.0.0.5", "multicast_port": 5005},
    )
    assert r.status_code == 400
    assert persisted == []  # rejected before any write


def test_set_config_persists(monkeypatch) -> None:
    persisted = {}
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: persisted.__setitem__(k, v) or True)
    monkeypatch.setattr(nf, "_get_int", lambda k, d, lo, hi: 6000 if k == nf.KEY_PORT else 1)
    monkeypatch.setattr(nf, "_get_str", lambda k, d: "239.5.5.5")
    r = client.post(
        "/local/notify/config",
        json={"enabled": True, "multicast_group": "239.5.5.5", "multicast_port": 6000},
    )
    assert r.status_code == 200
    assert persisted[nf.KEY_GROUP] == "239.5.5.5"
    assert persisted[nf.KEY_PORT] == "6000"
    assert persisted[nf.KEY_ENABLE] == "1"
