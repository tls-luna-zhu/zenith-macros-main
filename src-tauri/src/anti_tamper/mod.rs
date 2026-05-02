//! Anti-tamper checks run at startup.
//!
//! These are lightweight heuristics designed to detect the most common
//! reverse-engineering environments.  None of them are bullet-proof in
//! isolation; they raise the bar for casual reverse engineering.

// ---------------------------------------------------------------------------
// Debugger detection
// ---------------------------------------------------------------------------

/// Returns `true` when a debugger appears to be attached.
///
/// Uses two independent signals:
///  1. The `IsDebuggerPresent` Win32 API.
///  2. A timing side-channel: a tight loop that takes significantly longer
///     when single-stepped by a debugger.
pub fn is_debugger_present() -> bool {
    #[cfg(target_os = "windows")]
    {
        if windows_debugger_present() {
            return true;
        }
    }

    timing_check()
}

#[cfg(target_os = "windows")]
fn windows_debugger_present() -> bool {
    use windows_sys::Win32::System::Diagnostics::Debug::IsDebuggerPresent;
    // SAFETY: This is a simple query with no side-effects.
    unsafe { IsDebuggerPresent() != 0 }
}

/// Timing-based debugger detection.
///
/// A tight loop of ~1 000 iterations should complete in under 1 ms on
/// modern hardware.  A software debugger processing every instruction will
/// take orders of magnitude longer.
fn timing_check() -> bool {
    use std::time::Instant;

    let start = Instant::now();
    let mut x: u64 = 0;
    for i in 0..1_000u64 {
        x = x.wrapping_add(i.wrapping_mul(3));
    }
    // Prevent the loop from being optimised away
    let _ = std::hint::black_box(x);

    start.elapsed().as_millis() > 50
}

// ---------------------------------------------------------------------------
// Virtual machine detection
// ---------------------------------------------------------------------------

/// Returns `true` when the hypervisor bit (ECX bit 31) is set by CPUID,
/// indicating that the process is running inside a virtual machine.
pub fn is_vm() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        let result = std::arch::x86_64::__cpuid(1);
        // Bit 31 of ECX is the hypervisor present bit
        return (result.ecx >> 31) & 1 == 1;
    }

    #[allow(unreachable_code)]
    false
}

// ---------------------------------------------------------------------------
// Combined check
// ---------------------------------------------------------------------------

/// Run all anti-tamper checks and return an error string if any trigger.
///
/// Callers should abort or refuse to start the protected feature when this
/// returns `Err`.
pub fn run_checks() -> Result<(), String> {
    if is_debugger_present() {
        return Err("Integrity check failed (code: 0x01)".to_string());
    }

    if is_vm() {
        // CPUID hypervisor-bit detection is too noisy on modern Windows
        // systems (Hyper-V/VBS can set it on legitimate machines).
        // Keep optional strict mode for controlled environments.
        let strict_vm_block = std::env::var("ZENITH_BLOCK_VM")
            .ok()
            .map(|value| {
                let normalized = value.trim().to_ascii_lowercase();
                normalized == "1" || normalized == "true" || normalized == "yes"
            })
            .unwrap_or(false);

        if strict_vm_block {
            return Err("Integrity check failed (code: 0x02)".to_string());
        }

        eprintln!("[anti_tamper] VM/hypervisor flag detected; continuing (set ZENITH_BLOCK_VM=1 to enforce block)");
    }

    Ok(())
}
