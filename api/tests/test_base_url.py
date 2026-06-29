"""Tests for _base_url's scheme/port derivation.

The reader row stores scheme, address and port separately. The port column is
an *override*: when it is empty or set to a standard web port (80/443), the URL
follows the scheme's default (http -> 80, https -> 443). Only a non-standard
port overrides that. This is what lets flipping scheme http->https move the URL
from :80 to :443 without the operator hand-editing the port, while still
honouring a genuinely custom port.
"""
from app.rfid_status import _base_url


def test_http_defaults_to_80():
    assert _base_url({"scheme": "http", "address": "10.0.0.5"}) == "http://10.0.0.5:80"


def test_https_defaults_to_443_when_port_null():
    assert _base_url({"scheme": "https", "address": "10.0.0.5", "port": None}) == "https://10.0.0.5:443"


def test_https_with_stale_http_port_80_uses_443():
    # The reported bug: row was created over http (port=80) then flipped to
    # https. The stale 80 must not pin an https URL to the closed http port.
    assert _base_url({"scheme": "https", "address": "10.10.48.119", "port": 80}) == "https://10.10.48.119:443"


def test_http_with_443_uses_80():
    # Symmetric: 443 is a standard port, so under http it follows the scheme.
    assert _base_url({"scheme": "http", "address": "10.0.0.5", "port": 443}) == "http://10.0.0.5:80"


def test_custom_port_overrides_for_http():
    assert _base_url({"scheme": "http", "address": "10.0.0.5", "port": 8080}) == "http://10.0.0.5:8080"


def test_custom_port_overrides_for_https():
    assert _base_url({"scheme": "https", "address": "10.0.0.5", "port": 8443}) == "https://10.0.0.5:8443"


def test_scheme_case_and_whitespace_tolerated():
    assert _base_url({"scheme": " HTTPS ", "address": " 10.0.0.5 ", "port": 80}) == "https://10.0.0.5:443"


def test_bad_port_falls_back_to_scheme_default():
    assert _base_url({"scheme": "https", "address": "10.0.0.5", "port": "nope"}) == "https://10.0.0.5:443"
