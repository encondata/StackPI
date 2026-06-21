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

    monkeypatch.setattr(sb, "_primary_uptime", lambda: 12345)
    snap = sb.build_snapshot()
    assert snap["v"] == 2
    assert snap["uptime"] == 12345
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


def test_build_snapshot_honors_exclusions(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.local.local_metrics",
        lambda: {"tags_today": 5, "readers_up": 1, "readers_total": 2, "last_sync": "x"},
    )
    monkeypatch.setattr("app.rfid.get_active_reader", lambda: {"state": "online", "name": "R1", "configured": True})
    monkeypatch.setattr("app.local.local_overview", lambda settings: {"registration": {"status": "registered"}})
    monkeypatch.setattr("app.rfid.matches_recent", lambda limit: {"matches": [{"i": 1}]})
    monkeypatch.setattr(sb, "_recent_events", lambda limit: [{"id": 1}])
    # Exclude the readers metric card + the reader section + events.
    monkeypatch.setattr(sb, "status_excluded", lambda: {"metric:readers", "reader", "events"})

    snap = sb.build_snapshot()
    assert "readers_up" not in snap["metrics"] and "readers_total" not in snap["metrics"]
    assert snap["metrics"]["tags_today"] == 5  # other cards untouched
    assert snap["reader"] == {}            # section skipped
    assert snap["events"] == []            # section skipped
    assert snap["registration"] == {"status": "registered"}  # still on
    assert snap["activity"] == [{"i": 1}]                      # still on


def test_status_excluded_drops_stale_ids(monkeypatch) -> None:
    monkeypatch.setattr("app.settings._get_setting_str", lambda k, d: "metric:readers, bogus:id ,events")
    assert sb.status_excluded() == {"metric:readers", "events"}


def test_status_config_get_includes_catalog(monkeypatch) -> None:
    monkeypatch.setattr(sb, "status_enabled", lambda: True)
    monkeypatch.setattr(sb, "status_excluded", lambda: {"events"})
    monkeypatch.setattr("app.notifier._get_str", lambda k, d: "239.10.10.11")
    monkeypatch.setattr("app.notifier._get_int", lambda k, d, lo, hi: 5006)
    body = client.get("/local/notify/status-config").json()
    assert body["excluded"] == ["events"]
    ids = {e["id"] for e in body["catalog"]}
    assert "metric:readers" in ids and "events" in ids


def test_status_config_post_persists_excluded(monkeypatch) -> None:
    persisted = {}
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: persisted.__setitem__(k, v) or True)
    monkeypatch.setattr(sb, "status_enabled", lambda: True)
    monkeypatch.setattr(sb, "status_excluded", lambda: set())
    monkeypatch.setattr("app.notifier._get_str", lambda k, d: "239.9.9.9")
    monkeypatch.setattr("app.notifier._get_int", lambda k, d, lo, hi: 5006)
    r = client.post(
        "/local/notify/status-config",
        json={
            "enabled": True,
            "multicast_group": "239.9.9.9",
            "multicast_port": 5006,
            "excluded": ["metric:readers", "events", "bogus:id"],
        },
    )
    assert r.status_code == 200
    # stale "bogus:id" filtered out; rest persisted as sorted CSV
    assert persisted[sb.KEY_STATUS_EXCLUDE] == "events,metric:readers"


def test_diff_scalars_and_feeds() -> None:
    last = {
        "metrics": {"tags_today": 5}, "reader": {"state": "online"},
        "registration": {"status": "registered"},
        "activity": [{"id": 2}, {"id": 1}], "events": [{"id": 9}],
    }
    # unchanged → None
    assert sb._diff(dict(last), last) is None
    # a metric changes + a new activity item + a new event
    current = {
        "metrics": {"tags_today": 6}, "reader": {"state": "online"},
        "registration": {"status": "registered"},
        "activity": [{"id": 3}, {"id": 2}, {"id": 1}], "events": [{"id": 10}, {"id": 9}],
    }
    d = sb._diff(current, last)
    assert d == {"metrics": {"tags_today": 6}, "activity_new": [{"id": 3}], "events_new": [{"id": 10}]}
    # reader/registration unchanged are NOT included
    assert "reader" not in d and "registration" not in d


def test_uptime_not_in_diff() -> None:
    # uptime differing must NOT by itself produce a delta (it's not diffed)
    base = {"metrics": {}, "reader": {}, "registration": {}, "activity": [], "events": []}
    a = {**base, "uptime": 100}
    b = {**base, "uptime": 101}
    assert sb._diff(a, b) is None


def test_build_snapshot_excludes_uptime(monkeypatch) -> None:
    monkeypatch.setattr("app.local.local_metrics", lambda: {"tags_today": 1})
    monkeypatch.setattr(sb, "status_excluded", lambda: {"uptime"})
    monkeypatch.setattr(sb, "_primary_uptime", lambda: 999)
    snap = sb.build_snapshot()
    assert "uptime" not in snap


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
