"""The durable jobs counter: load, increment, persistence, corruption."""

from app.jobs.stats import CounterStore


def test_missing_file_starts_at_zero(tmp_path):
    store = CounterStore(tmp_path / "stats.json")
    assert store.count == 0


def test_increment_persists_across_reload(tmp_path):
    path = tmp_path / "stats.json"
    store = CounterStore(path)
    assert store.increment() == 1
    assert store.increment() == 2
    assert CounterStore(path).count == 2


def test_corrupt_file_starts_at_zero(tmp_path):
    path = tmp_path / "stats.json"
    path.write_text("{not json", encoding="utf-8")
    assert CounterStore(path).count == 0


def test_wrong_shape_starts_at_zero(tmp_path):
    path = tmp_path / "stats.json"
    path.write_text('{"jobs_completed": "many"}', encoding="utf-8")
    assert CounterStore(path).count == 0


def test_data_dir_setting_defaults():
    from app.core.config import Settings

    assert Settings(_env_file=None).data_dir == "./data"
