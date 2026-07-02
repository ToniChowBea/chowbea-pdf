"""Settings additions for the job queue and deploy traceability."""

from app.core.config import Settings


def test_queue_settings_defaults():
    settings = Settings(_env_file=None)
    assert settings.rabbitmq_url == "amqp://guest:guest@localhost:5672/"
    assert settings.result_ttl_minutes == 30
    assert settings.job_concurrency == 3


def test_commit_sha_defaults_to_dev():
    settings = Settings(_env_file=None)
    assert settings.commit_sha == "dev"


def test_health_reports_commit(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["commit"] == "dev"
