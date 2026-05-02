"""
Creates .nsis.zip, signs it with the minisign key, and creates the GitHub release for v1.2.7.
"""
import base64, hashlib, os, struct, subprocess, sys, zipfile
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT   = Path(__file__).resolve().parent.parent
NSIS   = ROOT / "src-tauri/target/release/bundle/nsis"
EXE    = NSIS / "ZenithMacros_1.2.7_x64-setup.exe"
ZIP    = NSIS / "ZenithMacros_1.2.7_x64-setup.nsis.zip"
SIG    = NSIS / "ZenithMacros_1.2.7_x64-setup.nsis.zip.sig"
PORT   = ROOT / "src-tauri/target/release/ZenithMacros.exe"
KEY    = Path.home() / ".tauri/zenith.key"
VER    = "1.2.7"
REPO   = "harrisonjonathan05-dev/zenith-releases"
NOTES  = "Fix auto-updater not applying update; add update notification toast in top-right corner"

# ── 1. Create .nsis.zip ───────────────────────────────────────────────────────
print(f"[1] Zipping {EXE.name} ...")
with zipfile.ZipFile(ZIP, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    zf.write(EXE, EXE.name)
print(f"    -> {ZIP.name} ({ZIP.stat().st_size // 1024 // 1024} MB)")

# ── 2. Sign with minisign key ─────────────────────────────────────────────────
print("[2] Signing ...")
# Key file is itself base64-encoded; decode it first to get standard minisign format
key_outer = base64.b64decode(KEY.read_bytes())
raw_b64   = key_outer.split(b"\n")[1].decode()    # second line is the key payload
raw       = base64.b64decode(raw_b64)

# minisign encrypted secret key layout:
#   2  sig_algo  (b"ED")
#   2  kdf_algo  (b"Sc")
#   2  chk_algo  (b"B2")
#   4  kdf_memlimit (le u32)  — actually 8 bytes le u64
#   8  kdf_opslimit (le u64)
#   32 kdf_salt
#   8  keynum
#   104 encrypted_key (keynum 8 + seed 32 + pk 32 + checksum 32 = 104)
#
# rsign layout is slightly different — let's parse carefully
# sig_algo(2) kdf_algo(2) chk_algo(2) kdf_memlimit(8) kdf_opslimit(8) kdf_salt(32) keynum(8) encrypted_key(104)

# Layout: sig[2] kdf[2] chk[2] salt[32] opslimit[8 LE] memlimit[8 LE] encrypted[104]
kdf_salt   = raw[6:38]
kdf_ops    = struct.unpack("<Q", raw[38:46])[0]
kdf_mem    = struct.unpack("<Q", raw[46:54])[0]
enc_data   = raw[54:158]            # 104 bytes: keynum[8]+seed[32]+pk[32]+chk[32]
N          = kdf_mem // (8 * 128)   # scrypt N parameter

print(f"    kdf_mem={kdf_mem} kdf_ops={kdf_ops} N={N}")

from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.backends import default_backend

kdf = Scrypt(salt=kdf_salt, length=104, n=N, r=8, p=1, backend=default_backend())
stream = kdf.derive(b"")           # empty password
decrypted = bytes(a ^ b for a, b in zip(enc_data, stream))

# decrypted = keynum(8) + seed(32) + pk(32) + checksum(32)
seed = decrypted[8:40]
pk   = decrypted[40:72]

private_key = Ed25519PrivateKey.from_private_bytes(seed)

# Sign the zip file data
zip_data  = ZIP.read_bytes()
signature = private_key.sign(zip_data)

# Build minisign .sig format
pub_b64   = Path(KEY.parent / "zenith.pub").read_text() if (KEY.parent / "zenith.pub").exists() else None
keynum_bytes = decrypted[0:8]
ts = int(__import__('time').time())

sig_header = b"untrusted comment: signature from tauri secret key\n"
sig_b64    = base64.b64encode(b"ED" + keynum_bytes + signature).decode()
trust_comment = f"trusted comment: timestamp:{ts}\tfile:{ZIP.name}\thashed\n"
global_sig = private_key.sign((sig_b64 + "\n" + trust_comment).encode())
global_b64 = base64.b64encode(global_sig).decode()

# Write in binary mode — prevents Python on Windows from mangling \n -> \r\n
sig_content = sig_header + sig_b64.encode() + b"\n" + trust_comment.encode() + global_b64.encode() + b"\n"
SIG.write_bytes(sig_content)
print(f"    -> {SIG.name}")

# ── 3. Create GitHub release ──────────────────────────────────────────────────
print(f"[3] Creating GitHub release v{VER} ...")
gh = r"C:\Program Files\GitHub CLI\gh.exe"

notes_file = ROOT / "scripts/_release_notes.tmp"
notes_file.write_text(NOTES, encoding="utf-8")

files = [str(ZIP), str(SIG), str(EXE)]
if PORT.exists():
    files.append(str(PORT))
    print(f"    including portable exe: {PORT.name}")

cmd = [gh, "release", "create", f"v{VER}",
       "--title", f"v{VER}",
       "--notes-file", str(notes_file),
       "--repo", REPO] + files

print("    Running:", " ".join(cmd[:6]), "...")
result = subprocess.run(cmd, capture_output=True, text=True)
notes_file.unlink(missing_ok=True)

if result.returncode != 0:
    print("STDERR:", result.stderr)
    print("STDOUT:", result.stdout)
    sys.exit(1)

print(f"    GitHub release v{VER} created!")
print(result.stdout.strip())
print("\nDone.")
