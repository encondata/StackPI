from fastapi.testclient import TestClient

from app.main import app
from app import status_broadcast as sb

client = TestClient(app)


# --- build_snapshot ---------------------------------------------------------

def test_build_snapshot_shape(monkeypatch) -> None:
    monkeypatch.setattr("app.local.local_metrics", lambda: {"tags_today": 5, "readers_up": 1})
    monkeypatch.setattr(
        "app.rfid.get_active_reader",
        lambda: {"configured": True, "state": "reading", "name": "R1"},
    )
    monkeypatch.setattr("app.local.local_overview", lambda settings: {"registration": {"status": "registered"}})
    monkeypatch.setattr("app.rfid.matches_recent", lambda limit: {"matches": [{"i": i} for i in range(50)]})
    monkeypatch.setattr(sb, "_recent_events", lambda limit: [{"id": i} for i in range(limit)])

    snap = sb.build_snapshot()
    assert snap["v"] == 1
    assert snap["type"] == "status"
    assert "ts" in snap
    assert snap["metrics"] == {"tags_today": 5, "readers_up": 1}
    assert snap["reader"] == {"state": "reading", "name": "R1", "configured": True}
    assert snap["registration"] == {"status": "registered"}
    # bounded lists
    assert len(snap["activity"]) == sb.ACTIVITY_LIMIT
    assert len(snap["events"]) == sb.EVENTS_LIMIT


def test_build_snapshot_best_effort(monkeypatch) -> None:
    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr("app.local.local_metrics", boom)
    monkeypatch.setattr("app.rfid.get_active_reader", boom)
    monkeypatch.setattr("app.local.local_overview", boom)
    monkeypatch.setattr("app.rfid.matches_recent", boom)
    monkeypatch.setattr(sb, "_recent_events", boom)

    snap = sb.build_snapshot()  # must not raise
    assert snap["type"] == "status"
    assert snap["metrics"] == {}
    assert snap["reader"] == {}
    assert snap["activity"] == []
    assert snap["events"] == []


def test_mark_dirty_noop_without_loop(monkeypatch) -> None:
    monkeypatch.setattr(sb, "_loop", None)
    sb.mark_dirty()  # must not raise


# --- status-config endpoints ------------------------------------------------

def test_status_config_get(monkeypatch) -> None:
    monkeypatch.setattr(sb, "status_enabled", lambda: True)
    monkeypatch.setattr("app.notifier._get_str", lambda k, d: "239.10.10.11")
    monkeypatch.setattr("app.notifier._get_int", lambda k, d, lo, hi: 5006)
    body = client.get("/local/notify/status-config").json()
    assert body["enabled"] is True
    assert body["multicast_group"] == "239.10.10.11"
    assert body["multicast_port"] == 5006


def test_status_config_post_persists(monkeypatch) -> None:
    persisted = {}
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: persisted.__setitem__(k, v) or True)
    monkeypatch.setattr(sb, "status_enabled", lambda: True)
    monkeypatch.setattr("app.notifier._get_str", lambda k, d: "239.9.9.9")
    monkeypatch.setattr("app.notifier._get_int", lambda k, d, lo, hi: 5007)
    r = client.post(
        "/local/notify/status-config",
        json={"enabled": True, "multicast_group": "239.9.9.9", "multicast_port": 5007},
    )
    assert r.status_code == 200
    assert persisted[sb.KEY_STATUS_GROUP] == "239.9.9.9"
    assert persisted[sb.KEY_STATUS_PORT] == "5007"
    assert persisted[sb.KEY_STATUS_ENABLE] == "1"


def test_status_config_rejects_non_multicast(monkeypatch) -> None:
    persisted = []
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: persisted.append(k) or True)
    r = client.post(
        "/local/notify/status-config",
        json={"enabled": True, "multicast_group": "10.0.0.1", "multicast_port": 5006},
    )
    assert r.status_code == 400
    assert persisted == []
