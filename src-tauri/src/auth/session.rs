//! Client-side auth session storage and management.

use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

use super::crypto::verify_session_token_expiry;

// ---------------------------------------------------------------------------
// AuthSession
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSession {
    /// The raw JWT session token.
    pub token: String,
    /// Normalized license key used for the session.
    pub key: String,
    /// The per-user AES-256 key (32 bytes), stored in RAM only.
    /// Serialised as a hex string so we can persist it in the store.
    #[serde(with = "hex_serde")]
    pub user_enc_key: [u8; 32],
    /// License tier: "monthly" or "lifetime".
    pub tier: String,
    /// Unix timestamp (ms) when the session expires.
    pub expires_at_ms: u64,
    /// Hardware fingerprint used during auth.
    pub hwid_fp: String,
}

impl AuthSession {
    fn is_sane(&self) -> bool {
        // [SECURITY HARDENING] Lightweight shape checks only; do not alter
        // normal auth flow for valid sessions.
        let token_ok = {
            let len = self.token.len();
            len >= 32 && len <= 4096 && self.token.split('.').count() == 3
        };
        let key_ok = {
            let len = self.key.len();
            len >= 8 && len <= 64 && self.key.chars().all(|c| c.is_ascii_alphanumeric())
        };
        let hwid_ok = self.hwid_fp.len() == 64 && self.hwid_fp.chars().all(|c| c.is_ascii_hexdigit());
        token_ok && key_ok && hwid_ok
    }

    pub fn is_expired(&self) -> bool {
        // Check the exp embedded in the JWT itself (more reliable than
        // the local expires_at_ms which may drift with the session TTL).
        !verify_session_token_expiry(&self.token)
    }

    pub fn save_token(&self, store: &crate::AppStore) {
        let json = match serde_json::to_string(self) {
            Ok(v) => v,
            Err(_) => return,
        };
        let _ = store.update(|root| {
            match protect_session_payload(&json) {
                Some(protected) => {
                    root.insert("authSessionProtected".into(), serde_json::Value::String(protected));
                    root.remove("authSession");
                }
                None => {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
                        root.insert("authSession".into(), value);
                    }
                    root.remove("authSessionProtected");
                }
            }
        });
    }

    pub fn load_token(store: &crate::AppStore) -> Option<Self> {
        let protected = store.read_field("authSessionProtected");
        if let Some(payload) = protected.as_str() {
            if let Some(decrypted) = unprotect_session_payload(payload) {
                if let Ok(session) = serde_json::from_str::<Self>(&decrypted) {
                    if session.is_sane() {
                        return Some(session);
                    }
                }
            }
        }

        let raw = store.read_field("authSession");
        if raw.is_null() {
            return None;
        }
        let parsed = serde_json::from_value::<Self>(raw).ok();
        match parsed {
            Some(session) if session.is_sane() => Some(session),
            _ => {
                // [SECURITY HARDENING] Drop malformed/tampered local sessions.
                Self::clear(store);
                None
            }
        }
    }

    pub fn clear(store: &crate::AppStore) {
        let _ = store.update(|root| {
            root.remove("authSession");
            root.remove("authSessionProtected");
        });
    }

    /// Session shape used when `free_standalone` is enabled: satisfies `is_sane` / JWT `exp` checks without a server.
    #[cfg(feature = "free_standalone")]
    pub fn free_standalone_dummy() -> Self {
        const TOKEN: &str = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQxMDI0NDQ4MDB9.standalonefreebuildsigpad";
        Self {
            token: TOKEN.into(),
            key: "STANDALONE".into(),
            user_enc_key: [0u8; 32],
            tier: "free".into(),
            expires_at_ms: 0,
            hwid_fp: "0".repeat(64),
        }
    }
}

// ---------------------------------------------------------------------------
// Shared state (managed by Tauri)
// ---------------------------------------------------------------------------

pub type SharedAuthSession = Arc<Mutex<Option<AuthSession>>>;

pub fn new_shared() -> SharedAuthSession {
    Arc::new(Mutex::new(None))
}

#[cfg(windows)]
fn protect_session_payload(payload: &str) -> Option<String> {
    use base64::Engine;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: payload.len() as u32,
        pbData: payload.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

    let ok = unsafe {
        CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if ok == 0 || output.pbData.is_null() {
        return None;
    }

    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as _);
    }
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(not(windows))]
fn protect_session_payload(_payload: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn unprotect_session_payload(payload: &str) -> Option<String> {
    use base64::Engine;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    let protected = base64::engine::general_purpose::STANDARD.decode(payload).ok()?;
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if ok == 0 || output.pbData.is_null() {
        return None;
    }

    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as _);
    }
    String::from_utf8(bytes).ok()
}

#[cfg(not(windows))]
fn unprotect_session_payload(_payload: &str) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------
// Hex serde for [u8; 32]
// ---------------------------------------------------------------------------

mod hex_serde {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let hex_str = String::deserialize(d)?;
        let bytes = hex::decode(&hex_str).map_err(serde::de::Error::custom)?;
        bytes
            .try_into()
            .map_err(|_| serde::de::Error::custom("expected 32-byte hex string"))
    }
}
