//! Client-side challenge-response authentication flow.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::crypto::hmac_sha256_hex;
use super::hwid::compute_hwid;

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ChallengeResult {
    pub session_token: String,
    pub user_enc_key: [u8; 32],
    pub tier: String,
    pub expires_at: String,
    /// The HWID fingerprint used during this auth — stored in the session so
    /// the refresh call can include the same value.
    pub hwid_fp: String,
}

#[derive(Debug, Clone)]
pub struct RefreshResult {
    pub session_token: String,
    pub tier: String,
    pub hwid_fp: String,
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChallengeResponse {
    challenge_id: String,
    challenge_nonce: String,
    challenge_token: String,
}

#[derive(Deserialize)]
struct VerifyResponse {
    ok: bool,
    session_token: Option<String>,
    tier: Option<String>,
    expires_at: Option<String>,
}

#[derive(Deserialize)]
struct RefreshResponse {
    ok: bool,
    session_token: Option<String>,
    tier: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub async fn perform_auth(license_key: &str, base_url: &str) -> Result<ChallengeResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // Normalize the key: uppercase + remove dashes so client/server agree.
    let norm_key: String = license_key
        .trim()
        .to_uppercase()
        .chars()
        .filter(|c| *c != '-')
        .collect();

    if norm_key.is_empty() {
        return Err("Authentication failed".to_string());
    }

    let key_prefix: String = norm_key.chars().take(4).collect();
    let hwid_fp = compute_hwid(&key_prefix);
    let client_ts = now_ms();
    let challenge_body = serde_json::json!({
        "hwid_fp":   hwid_fp,
        "client_ts": client_ts,
    });

    let resp = client
        .post(format!("{}/v1/auth/challenge", base_url))
        .json(&challenge_body)
        .send()
        .await
        .map_err(|e| { eprintln!("[auth] challenge request failed: {}", e); "Authentication failed".to_string() })?;

    eprintln!("[auth] challenge response status: {}", resp.status());
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        eprintln!("[auth] challenge error body: {}", body);
        return Err("Authentication failed".to_string());
    }

    let challenge: ChallengeResponse = resp
        .json()
        .await
        .map_err(|e| { eprintln!("[auth] challenge parse failed: {}", e); "Authentication failed".to_string() })?;

    let challenge_id = &challenge.challenge_id;
    let cr_msg = format!(
        "verify:{}:{}:{}:{}",
        challenge_id, challenge.challenge_nonce, hwid_fp, client_ts
    );
    let challenge_response = hmac_sha256_hex(norm_key.as_bytes(), cr_msg.as_bytes());

    let verify_body = serde_json::json!({
        "challenge_id":       challenge_id,
        "license_key":        norm_key,
        "hwid_fp":            hwid_fp,
        "challenge_response": challenge_response,
        "client_ts":          client_ts,
        "challenge_token":    challenge.challenge_token,
    });

    let verify_resp = client
        .post(format!("{}/v1/auth/verify", base_url))
        .json(&verify_body)
        .send()
        .await
        .map_err(|e| { eprintln!("[auth] verify request failed: {}", e); "Authentication failed".to_string() })?;

    eprintln!("[auth] verify response status: {}", verify_resp.status());
    if !verify_resp.status().is_success() {
        let body = verify_resp.text().await.unwrap_or_default();
        eprintln!("[auth] verify error body: {}", body);
        return Err("Authentication failed".to_string());
    }

    let verify: VerifyResponse = verify_resp
        .json()
        .await
        .map_err(|_| "Authentication failed".to_string())?;

    if !verify.ok {
        return Err("Authentication failed".to_string());
    }

    let session_token = verify.session_token.ok_or("Authentication failed")?;
    Ok(ChallengeResult {
        session_token,
        user_enc_key: [0u8; 32],
        tier: verify.tier.unwrap_or_else(|| "monthly".to_string()),
        expires_at: verify.expires_at.unwrap_or_default(),
        hwid_fp,
    })
}

pub async fn refresh_auth(session_token: &str, hwid_fp: &str, base_url: &str) -> Result<RefreshResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let refresh_body = serde_json::json!({
        "session_token": session_token,
        "hwid_fp": hwid_fp,
    });

    // Retry up to 2 times for transient network errors (connection refused, timeout).
    // A genuine auth failure (401/403 with ok:false) returns immediately.
    let mut last_err = String::new();
    for attempt in 0..2u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }

        let resp = match client
            .post(format!("{}/v1/session/refresh", base_url))
            .json(&refresh_body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue; // retry on connection error
            }
        };

        let status = resp.status();

        // Hard auth failure — don't retry, key is actually invalid
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err("Authentication failed".to_string());
        }

        if !status.is_success() {
            last_err = format!("HTTP {}", status);
            continue; // retry on 5xx / transient errors
        }

        let refresh: RefreshResponse = match resp.json().await {
            Ok(r) => r,
            Err(e) => { last_err = e.to_string(); continue; }
        };

        if !refresh.ok {
            return Err("Authentication failed".to_string());
        }

        return Ok(RefreshResult {
            session_token: refresh.session_token.ok_or("Authentication failed")?,
            tier: refresh.tier.unwrap_or_else(|| "monthly".to_string()),
            hwid_fp: hwid_fp.to_string(),
        });
    }

    Err(last_err)
}
