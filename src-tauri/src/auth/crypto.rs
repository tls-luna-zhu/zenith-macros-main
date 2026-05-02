use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

// ---------------------------------------------------------------------------
// HMAC-SHA256
// ---------------------------------------------------------------------------

/// Compute HMAC-SHA256 and return the raw 32-byte digest.
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .expect("HMAC accepts any key length");
    mac.update(data);
    let result = mac.finalize().into_bytes();
    result.into()
}

/// Compute HMAC-SHA256 and return a lowercase hex string (64 chars).
pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    let digest = hmac_sha256(key, data);
    hex::encode(digest)
}

// ---------------------------------------------------------------------------
// Session token inspection
// ---------------------------------------------------------------------------

/// Decode the JWT payload and check whether the token has expired.
///
/// This does NOT verify the signature - it is intentionally lightweight
/// and used only to decide whether a stored token needs refreshing.
pub fn verify_session_token_expiry(token: &str) -> bool {
    use std::time::{SystemTime, UNIX_EPOCH};

    let parts: Vec<&str> = token.splitn(3, '.').collect();
    if parts.len() != 3 {
        return false;
    }

    // base64url-decode the payload (middle part)
    let payload_b64 = parts[1];
    let padded = match payload_b64.len() % 4 {
        2 => format!("{}==", payload_b64),
        3 => format!("{}=", payload_b64),
        _ => payload_b64.to_string(),
    };

    let decoded = match base64::Engine::decode(
        &base64::engine::general_purpose::URL_SAFE,
        padded.as_bytes(),
    ) {
        Ok(b) => b,
        Err(_) => return false,
    };

    let payload_str = match std::str::from_utf8(&decoded) {
        Ok(s) => s,
        Err(_) => return false,
    };

    // Parse exp field from JSON without pulling in serde_json
    if let Some(exp_val) = extract_json_u64(payload_str, "exp") {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        return now < exp_val;
    }

    false
}

/// Extract a u64 field from a flat JSON object string without serde.
fn extract_json_u64(json: &str, field: &str) -> Option<u64> {
    let pattern = format!("\"{}\":", field);
    let idx = json.find(&pattern)?;
    let rest = &json[idx + pattern.len()..].trim_start();
    // Read digits until a non-digit char
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}
