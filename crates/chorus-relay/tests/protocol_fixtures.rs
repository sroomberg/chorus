//! Cross-language protocol contract: deserialize every example in protocol/fixtures.json.
use chorus_relay::protocol::{ClientMessage, HostToRelay, RelayToHost, ServerMessage};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixtures {
    server_messages: Vec<Value>,
    client_messages: Vec<Value>,
    host_to_relay: Vec<Value>,
    relay_to_host: Vec<Value>,
}

fn fixtures_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures.json")
}

fn load() -> Fixtures {
    let raw = std::fs::read_to_string(fixtures_path()).expect("read protocol/fixtures.json");
    serde_json::from_str(&raw).expect("parse protocol/fixtures.json")
}

fn assert_roundtrip<T>(value: &Value)
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let parsed: T = serde_json::from_value(value.clone())
        .unwrap_or_else(|e| panic!("deserialize failed for {value}: {e}"));
    let back = serde_json::to_value(&parsed).expect("reserialize");
    assert_eq!(
        back, *value,
        "round-trip mismatch\n left: {back}\nright: {value}"
    );
}

#[test]
fn fixtures_server_messages() {
    for value in load().server_messages {
        assert_roundtrip::<ServerMessage>(&value);
    }
}

#[test]
fn fixtures_client_messages() {
    for value in load().client_messages {
        assert_roundtrip::<ClientMessage>(&value);
    }
}

#[test]
fn fixtures_host_to_relay() {
    for value in load().host_to_relay {
        assert_roundtrip::<HostToRelay>(&value);
    }
}

#[test]
fn fixtures_relay_to_host() {
    for value in load().relay_to_host {
        assert_roundtrip::<RelayToHost>(&value);
    }
}
