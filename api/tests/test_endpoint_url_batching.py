"""_apply_endpoint_url must keep the FX9600's global batching/retention arrays
in sync with the endpoint connection count.

The reader keeps READER-GATEWAY.batching and READER-GATEWAY.retention as arrays
with exactly one object per endpoint connection, plus a per-connection
additionalOptions.{batching,retention}. Appending a connection without growing
those arrays makes the reader reject the PUT with HTTP 422
"Incorrect number of batching objects for the given endpoints". Verified against
a live FX9600 (10.10.48.119).
"""
from app.rfid_status import _apply_endpoint_url

URL = "http://10.10.48.172:8000/rfid-tags"


def _gw(config):
    return config["READER-GATEWAY"]


def _conns(config):
    return config["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"]


def test_fresh_config_adds_connection_with_additional_options_and_global_arrays():
    config = {"READER-GATEWAY": {"endpointConfig": {"data": {"event": {"connections": []}}}}}
    out = _apply_endpoint_url(config, URL)
    conns = _conns(out)
    assert len(conns) == 1
    assert conns[0]["type"] == "httpPost"
    assert conns[0]["options"]["URL"] == URL
    # The appended connection carries its own batching + retention.
    assert "batching" in conns[0]["additionalOptions"]
    assert "retention" in conns[0]["additionalOptions"]
    # Global arrays match the (1) connection count.
    assert len(_gw(out)["batching"]) == 1
    assert len(_gw(out)["retention"]) == 1


def test_appending_to_existing_connection_grows_both_global_arrays():
    config = {"READER-GATEWAY": {
        "batching": [{"maxPayloadSizePerReport": 1, "reportingInterval": 1}],
        "retention": [{"maxEventRetentionTimeInMin": 1, "maxNumEvents": 1, "throttle": 1}],
        "endpointConfig": {"data": {"event": {"connections": [
            {"type": "mqtt", "name": "x",
             "additionalOptions": {"batching": {"a": 1}, "retention": {"b": 2}}},
        ]}}},
    }}
    out = _apply_endpoint_url(config, URL)
    gw = _gw(out)
    assert len(_conns(out)) == 2  # mqtt + appended StackPI httpPost
    assert len(gw["batching"]) == 2
    assert len(gw["retention"]) == 2
    # The existing connection's own batching is preserved at its index.
    assert gw["batching"][0] == {"a": 1}
    assert gw["retention"][0] == {"b": 2}


def test_existing_httppost_updates_url_without_changing_counts():
    batching = {"maxPayloadSizePerReport": 256000, "reportingInterval": 2000}
    retention = {"maxEventRetentionTimeInMin": 500, "maxNumEvents": 150000, "throttle": 100}
    config = {"READER-GATEWAY": {
        "batching": [dict(batching)],
        "retention": [dict(retention)],
        "endpointConfig": {"data": {"event": {"connections": [
            {"type": "httpPost", "name": "StackPI",
             "additionalOptions": {"batching": dict(batching), "retention": dict(retention)},
             "options": {"URL": "http://old:8000/rfid-tags"}},
        ]}}},
    }}
    out = _apply_endpoint_url(config, URL)
    gw = _gw(out)
    assert len(_conns(out)) == 1
    assert _conns(out)[0]["options"]["URL"] == URL
    assert len(gw["batching"]) == 1
    assert len(gw["retention"]) == 1
