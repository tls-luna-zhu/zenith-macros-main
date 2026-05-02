"""
Sign a file using a minisign/tauri private key with empty password.
Usage: python sign_zip.py <file_to_sign> <private_key_path>
"""
import sys, struct, base64, time
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.backends import default_backend
import hashlib

def parse_private_key(key_path, password=b''):
    content = Path(key_path).read_bytes().strip()
    # Tauri stores the key file as base64 of the minisign text format
    # Decode once to get the text: "untrusted comment: ...\n<base64_binary>\n"
    try:
        decoded_text = base64.b64decode(content).decode('utf-8')
        lines = decoded_text.strip().splitlines()
        if lines[0].startswith('untrusted comment:'):
            raw = base64.b64decode(lines[1])
        else:
            raw = base64.b64decode(content)
    except Exception:
        # Already plain text format
        lines = content.decode('utf-8').strip().splitlines()
        raw = base64.b64decode(lines[1])

    # minisign private key format:
    # sig_alg[2] kdf_alg[2] chk_alg[2] kdf_salt[32] kdf_opslimit[8] kdf_memlimit[8] keynum_sk[104]
    offset = 0
    sig_alg   = raw[offset:offset+2]; offset += 2
    kdf_alg   = raw[offset:offset+2]; offset += 2
    chk_alg   = raw[offset:offset+2]; offset += 2
    kdf_salt  = raw[offset:offset+32]; offset += 32
    kdf_opslimit = struct.unpack_from('<Q', raw, offset)[0]; offset += 8
    kdf_memlimit = struct.unpack_from('<Q', raw, offset)[0]; offset += 8
    keynum_sk_enc = raw[offset:offset+104]; offset += 104

    print(f"sig_alg={sig_alg}, kdf_alg={kdf_alg}, chk_alg={chk_alg}")
    print(f"kdf_opslimit={kdf_opslimit}, kdf_memlimit={kdf_memlimit}")

    # Derive XOR key using scrypt
    if kdf_alg == b'Sc':
        # scrypt params: N=2^(opslimit/2), r=8, p=1 — but minisign uses opslimit directly as log2(N)
        # Actually minisign uses: N = 2^ceil(log2(memlimit/1024/32/8)), r=8, p=1
        # The actual encoding: opslimit is the scrypt N parameter directly as a le64
        # From libsodium: crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_SENSITIVE = 33554432 (2^25)
        #                 crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_SENSITIVE = 1073741824 (2^30)
        # For minisign: n = 2^(ceil(log2(memlimit/1024/32/8))), r=8, p=max(1, opslimit/(4*n*r))
        import math
        n_log2 = math.ceil(math.log2(kdf_memlimit / (1024 * 32 * 8))) if kdf_memlimit > 0 else 14
        n = 2 ** n_log2
        r = 8
        p = max(1, kdf_opslimit // (4 * n * r)) if kdf_opslimit > 0 else 1
        print(f"scrypt: N={n} (2^{n_log2}), r={r}, p={p}")
        print("Running scrypt KDF (this may take a while)...")
        kdf = Scrypt(salt=kdf_salt, length=104, n=n, r=r, p=p, backend=default_backend())
        stream = kdf.derive(password)
    elif kdf_alg == b'B2':
        # Blake2b-based KDF (no stretch)
        import hmac
        stream = bytes(104)  # no KDF = zero stream
    else:
        stream = bytes(104)

    # XOR to decrypt
    keynum_sk = bytes(a ^ b for a, b in zip(keynum_sk_enc, stream))

    # Parse keynum_sk: key_num[8] + sk[64] + chk[32]
    key_num = keynum_sk[0:8]
    sk_bytes = keynum_sk[8:72]   # Ed25519 seed (32) + pubkey (32) in libsodium format
    chk = keynum_sk[72:104]

    # Ed25519 seed is first 32 bytes of sk_bytes
    seed = sk_bytes[0:32]
    pub_bytes = sk_bytes[32:64]

    print(f"key_num={key_num.hex()}, seed={seed.hex()[:16]}...")
    return key_num, seed, pub_bytes


def sign_file(file_path, key_path, password=b''):
    file_path = Path(file_path)
    key_path = Path(key_path)
    sig_path = Path(str(file_path) + '.sig')

    key_num, seed, pub_bytes = parse_private_key(key_path, password)

    # Load Ed25519 private key from seed
    private_key = Ed25519PrivateKey.from_private_bytes(seed)

    # Read file data
    data = file_path.read_bytes()
    print(f"Signing {file_path.name} ({len(data)} bytes)...")

    # Minisign "hashed" mode: sign Blake2b-512 hash of the data
    # But Tauri uses the standard minisign format which signs blake2b of the file
    # Actually minisign signs: prehash = blake2b(data), then sign(prehash)
    # For "hashed" mode the signature is over blake2b512 of the data
    digest = hashlib.blake2b(data, digest_size=64).digest()

    # Ed25519 signature over the hash
    sig_bytes = private_key.sign(digest)

    # Build signature blob: sig_alg[2] + key_num[8] + sig[64] = 74 bytes
    sig_blob = b'Ed' + key_num + sig_bytes

    # Trusted comment
    ts = int(time.time())
    trusted_comment = f"timestamp:{ts}\tfile:{file_path.name}\thashed".encode()

    # Global signature: sign(sig_bytes + trusted_comment)
    global_sig = private_key.sign(sig_bytes + trusted_comment)

    # Write .sig file
    lines = [
        f"untrusted comment: signature from tauri secret key",
        base64.b64encode(sig_blob).decode(),
        f"trusted comment: {trusted_comment.decode()}",
        base64.b64encode(global_sig).decode(),
        ""
    ]
    sig_path.write_text('\n'.join(lines))
    print(f"Signature written to: {sig_path}")
    return sig_path


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(f"Usage: python {sys.argv[0]} <file> <key_path>")
        sys.exit(1)
    sign_file(sys.argv[1], sys.argv[2])
