"""reader-settings persists a durable snapshot the config page reads back."""
from app import setup as s

EMPTY = {"reader_name": None, "site_id": None, "site_name": None,
         "scan_type_id": None, "scan_type_name": None}


def test_set_reader_settings_writes_snapshot(monkeypatch, tmp_path):
    monkeypatch.setattr(s, "_READER_SETTINGS_FILE", tmp_path / "reader_settings.json")
    monkeypatch.setattr(s, "_basecamp", lambda *a, **k: {"ok": True})
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: True)
    body = s.ReaderSettingsRequest(reader_name="FX9600647D23", site_id=5, scan_type_id=2,
                                   site_name="Dock A", scan_type_name="RFID 2")
    s.set_reader_settings(body)
    assert s.get_reader_settings() == {
        "reader_name": "FX9600647D23", "site_id": 5, "site_name": "Dock A",
        "scan_type_id": 2, "scan_type_name": "RFID 2"}


def test_get_reader_settings_empty_when_absent(monkeypatch, tmp_path):
    monkeypatch.setattr(s, "_READER_SETTINGS_FILE", tmp_path / "nope.json")
    assert s.get_reader_settings() == EMPTY


def test_set_reader_settings_blank_names_become_null(monkeypatch, tmp_path):
    monkeypatch.setattr(s, "_READER_SETTINGS_FILE", tmp_path / "reader_settings.json")
    monkeypatch.setattr(s, "_basecamp", lambda *a, **k: {"ok": True})
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: True)
    body = s.ReaderSettingsRequest(reader_name="R", site_id=1, scan_type_id=1)
    s.set_reader_settings(body)
    out = s.get_reader_settings()
    assert out["site_name"] is None and out["scan_type_name"] is None
