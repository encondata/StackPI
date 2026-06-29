"""set_endpoint_url primes the reader config with an unchanged round-trip
before applying the endpoint.

The FX9600 normalizes READER-GATEWAY/xml on the first apply after the config is
edited (e.g. endpoints erased via the reader UI). Applying a structural change
(a new endpoint connection) at the same time as that normalization is rejected
with HTTP 422 (batching count, vendor file paths, or "invalid temperature
object", depending on what is un-normalized). PUTting the config back unchanged
once normalizes it; the subsequent endpoint PUT then applies cleanly.
"""
from app import rfid_status as rs


def _empty_config():
    return {"READER-GATEWAY": {"endpointConfig": {"data": {"event": {"connections": []}}}}}


def test_set_endpoint_url_primes_then_applies(monkeypatch):
    monkeypatch.setattr(rs, "_get_reader_row",
                        lambda rid: {"address": "10.0.0.5", "scheme": "https"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")

    gets = {"n": 0}

    def fake_get(reader, token):
        gets["n"] += 1
        return _empty_config()  # a fresh config each GET (normalization is reader-side)

    monkeypatch.setattr(rs, "_get_config", fake_get)

    puts = []

    def fake_put(reader, token, config):
        conns = config["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"]
        puts.append(conns[0]["options"]["URL"] if conns else None)

    monkeypatch.setattr(rs, "_put_config", fake_put)

    out = rs.set_endpoint_url(7, "http://pi:8000/rfid-tags")
    assert out["ok"] is True
    # Two GETs (before prime, after prime) and two PUTs (prime unchanged, then applied).
    assert gets["n"] == 2
    assert len(puts) == 2
    assert puts[0] is None                              # prime: no endpoint yet
    assert puts[1] == "http://pi:8000/rfid-tags"        # applied endpoint


def test_set_endpoint_url_reports_prime_failure(monkeypatch):
    monkeypatch.setattr(rs, "_get_reader_row",
                        lambda rid: {"address": "10.0.0.5", "scheme": "https"})
    monkeypatch.setattr(rs, "_login", lambda reader: "tok")
    monkeypatch.setattr(rs, "_get_config", lambda reader, token: _empty_config())

    def boom(reader, token, config):
        raise RuntimeError("config HTTP 422: nope")

    monkeypatch.setattr(rs, "_put_config", boom)
    out = rs.set_endpoint_url(7, "http://pi:8000/rfid-tags")
    assert out["ok"] is False
    assert "422" in out["error"]
