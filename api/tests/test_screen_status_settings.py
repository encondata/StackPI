from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

PATH = "/local/settings/screen-status"


def test_payload_exposes_style_default_and_options() -> None:
    r = client.get(PATH)
    assert r.status_code == 200
    body = r.json()
    assert body["change_border_style_default"] == "comet"
    assert body["change_border_style_options"] == ["comet", "pulse", "dual"]
    # Current value is always one of the allowed options.
    assert body["change_border_style"] in body["change_border_style_options"]


def test_unknown_style_is_rejected() -> None:
    r = client.post(PATH, json={"change_border_style": "sparkle"})
    assert r.status_code == 400
    assert "change_border_style" in r.json()["detail"]


def test_omitted_style_is_accepted() -> None:
    # Posting an unrelated field must not require change_border_style.
    r = client.post(PATH, json={"change_border_cycle_count": 2})
    assert r.status_code == 200
    assert "change_border_style" in r.json()


def test_valid_style_round_trips() -> None:
    # Posting a valid style persists and is reflected in the payload.
    r = client.post(PATH, json={"change_border_style": "pulse"})
    assert r.status_code == 200
    assert r.json()["change_border_style"] == "pulse"
    # Restore the default so the test doesn't leave non-default state behind.
    client.post(PATH, json={"change_border_style": "comet"})
