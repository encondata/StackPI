from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_healthcheck_returns_expected_payload() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "stackpi-api",
        "environment": "development",
    }
