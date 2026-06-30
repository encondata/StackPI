from app import settings as s


def test_get_time_includes_timezone_auto(monkeypatch):
    monkeypatch.setattr(s, "_run_helper", lambda *a, **k: "timezone=UTC\n" if a[0] == "get-time-status" else "")
    monkeypatch.setattr(s, "get_timezone_auto", lambda: True)
    out = s.get_time_status()
    assert out["timezone_auto"] is True


def test_manual_timezone_set_disables_auto(monkeypatch):
    seen = {}
    monkeypatch.setattr(s, "_run_helper", lambda *a, **k: "timezone=America/Chicago\n" if a[0] == "get-time-status" else "")
    monkeypatch.setattr(s, "set_timezone_auto", lambda enabled: seen.setdefault("enabled", enabled) or True)
    monkeypatch.setattr(s, "get_timezone_auto", lambda: False)
    s.set_timezone(s.TimezoneRequest(timezone="America/Chicago"))
    assert seen["enabled"] is False


def test_timezone_auto_enable_persists_and_detects(monkeypatch):
    seen = {}
    monkeypatch.setattr(s, "set_timezone_auto", lambda enabled: seen.setdefault("enabled", enabled) or True)
    import app.tz_auto as tz
    monkeypatch.setattr(tz, "apply_once", lambda: seen.setdefault("applied", True))
    monkeypatch.setattr(s, "_run_helper", lambda *a, **k: "timezone=UTC\n" if a[0] == "get-time-status" else "")
    monkeypatch.setattr(s, "get_timezone_auto", lambda: True)
    s.set_timezone_auto_route(s.TimezoneAutoRequest(enabled=True))
    assert seen["enabled"] is True and seen.get("applied") is True


def test_timezone_auto_disable_does_not_detect(monkeypatch):
    seen = {}
    monkeypatch.setattr(s, "set_timezone_auto", lambda enabled: seen.setdefault("enabled", enabled) or True)
    import app.tz_auto as tz
    monkeypatch.setattr(tz, "apply_once", lambda: seen.setdefault("applied", True))
    monkeypatch.setattr(s, "_run_helper", lambda *a, **k: "timezone=UTC\n" if a[0] == "get-time-status" else "")
    monkeypatch.setattr(s, "get_timezone_auto", lambda: False)
    s.set_timezone_auto_route(s.TimezoneAutoRequest(enabled=False))
    assert seen["enabled"] is False and "applied" not in seen
