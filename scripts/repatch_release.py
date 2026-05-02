"""
Re-zips the freshly-built NSIS installer, re-signs it, and overwrites the
existing GitHub release v1.2.7 assets with the corrected files.

Run this after 'tauri build' has produced a correctly-versioned binary.
"""
import base64, struct, subprocess, sys, zipfile
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.backends import default_backend

ROOT   = Path(__file__).resolve().parent.parent
NSIS   = ROOT / "src-tauri/target/release/bundle/nsis"
EXE    = NSIS / "ZenithMacros_1.2.7_x64-setup.exe"
ZIP    = NSIS / "ZenithMacros_1.2.7_x64-setup.nsis.zip"
SIG    = NSIS / "ZenithMacros_1.2.7_x64-setup.nsis.zip.sig"
PORT   = ROOT / "src-tauri/target/release/ZenithMacros.exe"
KEY    = Path.home() / ".tauri/zenith.key"
VER    = "1.2.7"
REPO   = "harrisonjonathan05-dev/zenith-releases"

# ── 0. Sanity check ───────────────────────────────────────────────────────────
import subprocess as _sp
def _ver(path):
    r = _sp.run(
        ["powershell", "-Command", f"(Get-Item '{path}').VersionInfo.ProductVersion"],
        capture_output=True, text=True
    )
    return r.stdout.strip()

setup_ver = _ver(EXE)
port_ver  = _ver(PORT)
print(f"[0] Version check:")
print(f"    NSIS installer : {setup_ver}")
print(f"    Portable exe   : {port_ver}")
if "1.2.7" not in setup_ver or "1.2.7" not in port_ver:
    print("ERROR: one or both binaries are NOT 1.2.7 — aborting.")
    sys.exit(1)
print("    Both are 1.2.7 OK")

# ── 1. Create fresh .nsis.zip ─────────────────────────────────────────────────
print(f"\n[1] Zipping {EXE.name} ...")
with zipfile.ZipFile(ZIP, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    zf.write(EXE, EXE.name)
print(f"    -> {ZIP.name} ({ZIP.stat().st_size // 1024 // 1024} MB)")

# ── 2. Sign with minisign key ─────────────────────────────────────────────────
print("\n[2] Signing ...")
key_outer = base64.b64decode(KEY.read_bytes())
raw_b64   = key_outer.split(b"\n")[1].decode()
raw       = base64.b64decode(raw_b64)

kdf_salt  = raw[6:38]
kdf_ops   = struct.unpack("<Q", raw[38:46])[0]
kdf_mem   = struct.unpack("<Q", raw[46:54])[0]
enc_data  = raw[54:158]
N         = kdf_mem // (8 * 128)

print(f"    kdf_mem={kdf_mem} kdf_ops={kdf_ops} N={N}")

kdf       = Scrypt(salt=kdf_salt, length=104, n=N, r=8, p=1, backend=default_backend())
stream    = kdf.derive(b"")
decrypted = bytes(a ^ b for a, b in zip(enc_data, stream))

seed      = decrypted[8:40]
private_key = Ed25519PrivateKey.from_private_bytes(seed)

zip_data  = ZIP.read_bytes()
signature = private_key.sign(zip_data)

keynum_bytes = decrypted[0:8]
ts = int(__import__('time').time())

sig_header    = b"untrusted comment: signature from tauri secret key\n"
sig_b64       = base64.b64encode(b"ED" + keynum_bytes + signature).decode()
trust_comment = f"trusted comment: timestamp:{ts}\tfile:{ZIP.name}\thashed\n"
# global_sig covers: sig_b64 line + trusted_comment line (without trailing newline per spec)
global_sig    = private_key.sign((sig_b64 + "\n" + trust_comment).encode())
global_b64    = base64.b64encode(global_sig).decode()

# Write in binary mode so Python on Windows doesn't mangle \n -> \r\n
sig_content = sig_header + sig_b64.encode() + b"\n" + trust_comment.encode() + global_b64.encode() + b"\n"
SIG.write_bytes(sig_content)
print(f"    -> {SIG.name}")

# ── 3. Upload to existing GitHub release (overwrite assets) ───────────────────
print(f"\n[3] Uploading to existing GitHub release v{VER} ...")
gh = r"C:\Program Files\GitHub CLI\gh.exe"

files = [str(ZIP), str(SIG), str(EXE), str(PORT)]
print(f"    Files: {[Path(f).name for f in files]}")

cmd = [gh, "release", "upload", f"v{VER}",
       "--clobber",
       "--repo", REPO] + files

print("    Running:", " ".join(cmd[:5]), "...")
result = subprocess.run(cmd, capture_output=True, text=True)

if result.returncode != 0:
    print("STDERR:", result.stderr)
    print("STDOUT:", result.stdout)
    sys.exit(1)

print(f"    Assets uploaded to v{VER} OK")
if result.stdout.strip():
    print(result.stdout.strip())
print("\nDone. Release v1.2.7 now contains correctly versioned binaries.")
