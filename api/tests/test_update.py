from fastapi.testclient import TestClient

from app.main import app
from app import update as update_mod

client = TestClient(app)


# --- /status ---------------------------------------------------------------

def _patch_git(monkeypatch, *, head, origin, behind, fetch_ok=True):
    """Stub the git shells so /status is deterministic and offline-safe."""
    def fake_git(args, timeout=update_mod.GIT_TIMEOUT_SEC):
        if args[:1] == ["rev-parse"] and args[1] == "HEAD":
            return head
        if args[:1] == ["rev-parse"] and args[1].startswith("origin/"):
            return origin
        if args[:1] == ["rev-list"]:
            return str(behind)
        raise AssertionError(f"unexpected git args: {args}")

    monkeypatch.setattr(update_mod, "_git", fake_git)
    monkeypatch.setattr(update_mod, "_fetch", lambda: fetch_ok)
    monkeypatch.setattr(update_mod, "_current_branch", lambda: "main")


def test_status_update_available(monkeypatch) -> None:
    _patch_git(monkeypatch, head="a" * 40, origin="b" * 40, behind=3)
    monkeypatch.setattr(update_mod, "_run_state", lambda: "idle")
    monkeypatch.setattr(update_mod, "_log_tail", lambda *a, **k: "")

    r = client.get("/local/update/status")
    assert r.status_code == 200
    body = r.json()
    assert body["current_short"] == "aaaaaaa"
    assert body["latest_short"] == "bbbbbbb"
    assert body["behind"] == 3
    assert body["update_available"] is True
    assert body["branch"] == "main"
    assert body["state"] == "idle"


def test_status_up_to_date(monkeypatch) -> None:
    same = "c" * 40
    _patch_git(monkeypatch, head=same, origin=same, behind=0)
    monkeypatch.setattr(update_mod, "_run_state", lambda: "idle")
    monkeypatch.setattr(update_mod, "_log_tail", lambda *a, **k: "")

    body = client.get("/local/update/status").json()
    assert body["behind"] == 0
    assert body["update_available"] is False


def test_status_offline_fetch_reports_flag(monkeypatch) -> None:
    _patch_git(monkeypatch, head="a" * 40, origin="b" * 40, behind=1, fetch_ok=False)
    monkeypatch.setattr(update_mod, "_run_state", lambda: "idle")
    monkeypatch.setattr(update_mod, "_log_tail", lambda *a, **k: "")

    body = client.get("/local/update/status").json()
    assert body["fetch_ok"] is False
    # Still compares against last-known origin ref.
    assert body["update_available"] is True


def test_status_git_error_is_500(monkeypatch) -> None:
    def boom(args, timeout=update_mod.GIT_TIMEOUT_SEC):
        raise RuntimeError("not a git repo")

    monkeypatch.setattr(update_mod, "_git", boom)
    r = client.get("/local/update/status")
    assert r.status_code == 500


# --- /start ----------------------------------------------------------------

def test_start_triggers_updater(monkeypatch) -> None:
    calls = {"args": None}
    monkeypatch.setattr(update_mod, "_unit_active", lambda: False)
    monkeypatch.setattr(update_mod, "_trigger_update", lambda b=None, c=None: calls.__setitem__("args", (b, c)))

    r = client.post("/local/update/start")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "started": True, "state": "running"}
    assert calls["args"] == (None, None)  # no body → current branch tip


def test_start_is_idempotent_while_unit_active(monkeypatch) -> None:
    triggered = {"n": 0}
    # The live systemd unit — not the state file — is the lock.
    monkeypatch.setattr(update_mod, "_unit_active", lambda: True)
    monkeypatch.setattr(update_mod, "_trigger_update", lambda b=None, c=None: triggered.__setitem__("n", triggered["n"] + 1))

    body = client.post("/local/update/start").json()
    assert body["already_running"] is True
    assert body["started"] is False
    assert triggered["n"] == 0


def test_start_not_blocked_by_stale_running_state(monkeypatch) -> None:
    # Regression: a 'running' state file left by a launch failure must NOT block
    # a retry. The decision is the unit, which is inactive here.
    triggered = {"n": 0}
    monkeypatch.setattr(update_mod, "_run_state", lambda: "running")
    monkeypatch.setattr(update_mod, "_unit_active", lambda: False)
    monkeypatch.setattr(update_mod, "_trigger_update", lambda b=None, c=None: triggered.__setitem__("n", triggered["n"] + 1))

    body = client.post("/local/update/start").json()
    assert body["started"] is True
    assert triggered["n"] == 1


def test_start_surfaces_trigger_failure(monkeypatch) -> None:
    def boom(b=None, c=None) -> None:
        raise RuntimeError("sudo: a password is required")

    monkeypatch.setattr(update_mod, "_unit_active", lambda: False)
    monkeypatch.setattr(update_mod, "_trigger_update", boom)

    r = client.post("/local/update/start")
    assert r.status_code == 500


# --- branch / commit selection ---------------------------------------------

def test_start_with_branch_and_commit(monkeypatch) -> None:
    captured = {}
    monkeypatch.setattr(update_mod, "_unit_active", lambda: False)
    monkeypatch.setattr(
        update_mod, "_trigger_update",
        lambda b=None, c=None: captured.update(branch=b, commit=c),
    )
    r = client.post("/local/update/start", json={"branch": "dev", "commit": "abcdef1"})
    assert r.status_code == 200
    assert captured == {"branch": "dev", "commit": "abcdef1"}


def test_start_rejects_bad_branch(monkeypatch) -> None:
    triggered = {"n": 0}
    monkeypatch.setattr(update_mod, "_unit_active", lambda: False)
    monkeypatch.setattr(update_mod, "_trigger_update", lambda b=None, c=None: triggered.__setitem__("n", 1))
    r = client.post("/local/update/start", json={"branch": "dev; rm -rf /"})
    assert r.status_code == 400
    assert triggered["n"] == 0  # never launched


def test_branches_endpoint(monkeypatch) -> None:
    monkeypatch.setattr(update_mod, "_fetch", lambda: True)
    monkeypatch.setattr(update_mod, "_current_branch", lambda: "dev")
    monkeypatch.setattr(update_mod, "_list_branches", lambda: ["dev", "main"])
    body = client.get("/local/update/branches").json()
    assert body == {"current_branch": "dev", "branches": ["dev", "main"], "fetch_ok": True}


def test_commits_endpoint(monkeypatch) -> None:
    monkeypatch.setattr(update_mod, "_fetch", lambda: True)
    sample = [{"sha": "a" * 40, "short": "aaaaaaa", "date": "2026-06-20T00:00:00Z", "subject": "tip"}]
    monkeypatch.setattr(update_mod, "_list_commits", lambda branch, limit: sample)
    body = client.get("/local/update/commits?branch=dev").json()
    assert body == {"branch": "dev", "commits": sample}


def test_commits_rejects_bad_branch() -> None:
    assert client.get("/local/update/commits?branch=bad;evil").status_code == 400


def test_parse_commits_multiline_body() -> None:
    def rec(h, s, d, a, b):
        return f"{h}\x1f{s}\x1f{d}\x1f{a}\x1f{b}\x00"

    out = "\n".join(
        [
            rec("a" * 40, "aaaaaaa", "2026-06-21T00:00:00Z", "Dev",
                "feat: thing\n\nlong body line 1\nline 2"),
            rec("b" * 40, "bbbbbbb", "2026-06-20T00:00:00Z", "Dev", "fix: bug"),
        ]
    )
    commits = update_mod._parse_commits(out)
    assert len(commits) == 2
    assert commits[0]["subject"] == "feat: thing"
    assert "long body line 1" in commits[0]["body"]
    assert commits[0]["author"] == "Dev"
    assert commits[0]["short"] == "aaaaaaa"
    assert commits[1]["subject"] == "fix: bug"
    assert commits[1]["body"] == "fix: bug"


def test_status_with_explicit_commit(monkeypatch) -> None:
    head = "a" * 40
    commit = "c" * 40

    def fake_git(args, timeout=update_mod.GIT_TIMEOUT_SEC):
        if args[:2] == ["rev-parse", "HEAD"]:
            return head
        if args[:1] == ["rev-list"]:
            return "5"
        raise AssertionError(f"unexpected git args: {args}")

    monkeypatch.setattr(update_mod, "_git", fake_git)
    monkeypatch.setattr(update_mod, "_fetch", lambda: True)
    monkeypatch.setattr(update_mod, "_current_branch", lambda: "main")
    monkeypatch.setattr(update_mod, "_run_state", lambda: "idle")
    monkeypatch.setattr(update_mod, "_log_tail", lambda *a, **k: "")

    body = client.get(f"/local/update/status?branch=dev&commit={commit}").json()
    assert body["branch"] == "dev"
    assert body["target_short"] == "ccccccc"
    assert body["update_available"] is True  # head != commit


# --- state reconciliation --------------------------------------------------

def test_effective_state_reconciles_dead_run(monkeypatch) -> None:
    # State file says running but the unit is gone → the run died → 'failed'.
    monkeypatch.setattr(update_mod, "_run_state", lambda: "running")
    monkeypatch.setattr(update_mod, "_unit_active", lambda: False)
    assert update_mod._effective_state() == "failed"


def test_effective_state_running_when_unit_active(monkeypatch) -> None:
    monkeypatch.setattr(update_mod, "_run_state", lambda: "running")
    monkeypatch.setattr(update_mod, "_unit_active", lambda: True)
    assert update_mod._effective_state() == "running"


def test_effective_state_passthrough_non_running(monkeypatch) -> None:
    monkeypatch.setattr(update_mod, "_run_state", lambda: "success")
    # Unit check is irrelevant for non-running states.
    monkeypatch.setattr(update_mod, "_unit_active", lambda: False)
    assert update_mod._effective_state() == "success"


# --- file-reading helpers --------------------------------------------------

def test_run_state_and_log_tail_read_files(monkeypatch, tmp_path) -> None:
    state = tmp_path / "update.state"
    logf = tmp_path / "update.log"
    state.write_text("success\n")
    logf.write_text("\n".join(f"line {i}" for i in range(500)))

    monkeypatch.setattr(update_mod, "STATE_FILE", state)
    monkeypatch.setattr(update_mod, "LOG_FILE", logf)

    assert update_mod._run_state() == "success"
    tail = update_mod._log_tail(10)
    assert tail.splitlines()[-1] == "line 499"
    assert len(tail.splitlines()) == 10


def test_run_state_missing_is_idle(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(update_mod, "STATE_FILE", tmp_path / "nope.state")
    assert update_mod._run_state() == "idle"
