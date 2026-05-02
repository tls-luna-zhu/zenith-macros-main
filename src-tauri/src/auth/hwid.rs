//! Windows hardware fingerprint for the desktop auth flow.
//!
//! SHA-256(machineGuid + firstMac + hostname + keyPrefix)
//!
//! Sources used for the fingerprint:
//!   - machineGuid : HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid  (raw UUID string)
//!   - firstMac    : First non-loopback adapter, colon-separated lowercase hex ("aa:bb:cc:dd:ee:ff")
//!   - hostname    : COMPUTERNAME env var  (same as os.hostname() on Windows)
//!   - keyPrefix   : First 4 chars of normalised license key (no dashes, uppercase)

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Registry: MachineGuid
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn machine_guid() -> String {
    use std::ptr;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Cryptography\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "MachineGuid\0".encode_utf16().collect();

    let mut hkey: HKEY = ptr::null_mut();
    let ret = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            0,
            KEY_READ,
            &mut hkey,
        )
    };
    if ret != 0 {
        return String::new();
    }

    // Buffer large enough for a GUID string (36 chars) plus null terminator
    let mut buf = vec![0u16; 64];
    let mut buf_bytes = (buf.len() * 2) as u32;
    let mut reg_type = 0u32;

    let ret = unsafe {
        RegQueryValueExW(
            hkey,
            value.as_ptr(),
            ptr::null_mut(),
            &mut reg_type,
            buf.as_mut_ptr() as *mut u8,
            &mut buf_bytes,
        )
    };
    unsafe { RegCloseKey(hkey) };

    if ret != 0 {
        return String::new();
    }

    // buf_bytes is the byte count including the null terminator
    let char_count = (buf_bytes / 2) as usize;
    let wide: Vec<u16> = buf[..char_count.min(buf.len())].to_vec();
    String::from_utf16_lossy(&wide)
        .trim_matches('\0')
        .to_string()
}

#[cfg(not(target_os = "windows"))]
fn machine_guid() -> String {
    String::new()
}

// ---------------------------------------------------------------------------
// MAC address (colon-separated lowercase, e.g. "aa:bb:cc:dd:ee:ff")
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn first_mac() -> String {
    use std::ptr;
    use windows_sys::Win32::{
        NetworkManagement::IpHelper::{GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH},
        Networking::WinSock::AF_UNSPEC,
    };

    let mut buf_len: u32 = 0;
    unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut buf_len,
        );
    }

    if buf_len == 0 {
        return "00:00:00:00:00:00".to_string();
    }

    let mut buf: Vec<u8> = vec![0u8; buf_len as usize];
    let rc = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            0,
            ptr::null_mut(),
            buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
            &mut buf_len,
        )
    };

    if rc != 0 {
        return "00:00:00:00:00:00".to_string();
    }

    let mut ptr = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !ptr.is_null() {
        let adapter = unsafe { &*ptr };
        // Skip loopback (24) and tunnel (131) adapters
        if adapter.IfType != 24 && adapter.IfType != 131 {
            let len = adapter.PhysicalAddressLength as usize;
            if len == 6 {
                let bytes = &adapter.PhysicalAddress[..6];
                if bytes.iter().any(|&b| b != 0) {
                    // Format as "aa:bb:cc:dd:ee:ff" — matches Node.js os.networkInterfaces()
                    return bytes
                        .iter()
                        .map(|b| format!("{:02x}", b))
                        .collect::<Vec<_>>()
                        .join(":");
                }
            }
        }
        ptr = adapter.Next;
    }

    "00:00:00:00:00:00".to_string()
}

#[cfg(not(target_os = "windows"))]
fn first_mac() -> String {
    "00:00:00:00:00:00".to_string()
}

// ---------------------------------------------------------------------------
// Hostname
// ---------------------------------------------------------------------------

fn hostname() -> String {
    // COMPUTERNAME is the same value returned by Node's os.hostname() on Windows
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Compute a 64-hex-char hardware fingerprint.
///
/// Hardware fingerprint algorithm:
/// ```text
/// SHA-256(machineGuid + firstMac + hostname + keyPrefix)
/// ```
/// *key_prefix* must be the first 4 characters of the **normalised** license
/// key (uppercase, dashes removed) — e.g. `"ZNTH"` for `"ZNTH-XXXX-XXXX"`.
pub fn compute_hwid(key_prefix: &str) -> String {
    let guid = machine_guid();
    let mac = first_mac();
    let host = hostname();

    // Direct concatenation — no separators — identical to the JS implementation
    let input = format!("{}{}{}{}", guid, mac, host, key_prefix);

    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}
