"""The app must start and serve /health even when RabbitMQ is unreachable."""

from fastapi.testclient import TestClient

from app.main import app


def test_app_starts_and_degrades_without_broker(pdf_bytes):
    # Enter the lifespan for real; localhost:5672 may or may not be running,
    # so only broker-independent behavior is asserted here.
    with TestClient(app) as client:
        body = client.get("/health").json()
        assert body["status"] == "ok"
        assert body["commit"]  # identifies the running deploy; "dev" locally
        assert client.get("/queue").status_code == 200
