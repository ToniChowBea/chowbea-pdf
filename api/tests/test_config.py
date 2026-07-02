"""Settings additions for the job queue."""

from app.core.config import Settings


def test_queue_settings_defaults():
    settings = Settings(_env_file=None)
    assert settings.rabbitmq_url == "amqp://guest:guest@localhost:5672/"
    assert settings.result_ttl_minutes == 30
    assert settings.job_concurrency == 3
