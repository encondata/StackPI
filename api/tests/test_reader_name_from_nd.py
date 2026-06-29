"""_reader_name_from_nd extracts the short reader name from nameAndDescription.

Covers the shapes the FX9600 nameAndDescription body might take, since the
exact structure isn't pinned across firmware. The cloud keys readers by the
short name (e.g. "FX9600647D23"), never the model description.
"""
from app.rfid import _reader_name_from_nd


def test_name_with_separate_description_field():
    nd = {"name": "FX9600647D23 FX9600 RFID Reader", "description": "FX9600 RFID Reader"}
    assert _reader_name_from_nd(nd) == "FX9600647D23"


def test_name_embeds_model_desc_without_description_field():
    # Empty/missing description -> fall back to the known model suffix.
    nd = {"name": "FX9600647D23 FX9600 RFID Reader"}
    assert _reader_name_from_nd(nd) == "FX9600647D23"


def test_already_clean_name_is_unchanged():
    nd = {"readerName": "FX9600647D23", "description": "FX9600 RFID Reader"}
    assert _reader_name_from_nd(nd) == "FX9600647D23"


def test_readername_combined_field():
    nd = {"readerName": "FX9600647D23 FX9600 RFID Reader"}
    assert _reader_name_from_nd(nd) == "FX9600647D23"


def test_name_that_only_matches_generic_rfid_reader_suffix():
    nd = {"name": "DockDoor3 RFID Reader"}
    assert _reader_name_from_nd(nd) == "DockDoor3"


def test_human_name_with_no_model_suffix_is_kept():
    nd = {"name": "Loading Dock 3"}
    assert _reader_name_from_nd(nd) == "Loading Dock 3"


def test_empty_or_missing_name_returns_none():
    assert _reader_name_from_nd({}) is None
    assert _reader_name_from_nd({"description": "FX9600 RFID Reader"}) is None
    assert _reader_name_from_nd("not-a-dict") is None
