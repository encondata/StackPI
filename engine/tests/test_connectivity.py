from app.agent import _connectivity_after, HEARTBEAT_FAILURE_THRESHOLD


def test_success_resets():
    assert _connectivity_after(200, 2) == (True, 0)


def test_failures_accumulate_then_offline():
    online, f = _connectivity_after(None, 0)
    assert (online, f) == (True, 1)
    online, f = _connectivity_after(None, f)
    assert (online, f) == (True, 2)
    online, f = _connectivity_after(None, f)
    assert (online, f) == (False, 3)  # threshold


def test_server_error_counts_as_failure():
    online, f = _connectivity_after(503, 2)
    assert online is False and f == 3
