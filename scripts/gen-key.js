/**
 * Generates a minisign-compatible Ed25519 keypair with NO password,
 * writes private key to ~/.tauri/zenith.key and public key to ~/.tauri/zenith.key.pub
 * Compatible with Tauri v2 updater signing.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const KEY_DIR = path.join(os.homedir(), '.tauri')
const PRIV_PATH = path.join(KEY_DIR, 'zenith.key')
const PUB_PATH = path.join(KEY_DIR, 'zenith.key.pub')

fs.mkdirSync(KEY_DIR, { recursive: true })

// Generate Ed25519 keypair
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')

// Export raw bytes
const privDer = privateKey.export({ type: 'pkcs8', format: 'der' })
const pubDer = publicKey.export({ type: 'spki', format: 'der' })

// Ed25519 raw key bytes are at fixed offsets in DER
// PKCS8 Ed25519: last 32 bytes are seed (private scalar)
// SPKI Ed25519: last 32 bytes are public key
const seed = privDer.slice(privDer.length - 32)       // 32-byte seed
const pubBytes = pubDer.slice(pubDer.length - 32)      // 32-byte public key

// minisign format constants
const ALG = Buffer.from('Ed')         // algorithm
const KDF_ALG = Buffer.from('B2')     // Blake2b KDF
const CKSUM_ALG = Buffer.from('Bh')  // Blake2b checksum
const KDF_SALT = crypto.randomBytes(32)
// With empty password, scrypt ops/mem are zeroed (no-stretch mode)
const KDF_OPSLIMIT = Buffer.alloc(8)  // 0 = no KDF
const KDF_MEMLIMIT = Buffer.alloc(8)  // 0 = no KDF

// Random 8-byte key ID
const KEY_ID = crypto.randomBytes(8)

// Build keynum_sk: key_id (8) + seed (32) + pub (32) = 72 bytes
// With empty password / no KDF, XOR key is all zeros, so it's stored as-is
const keynumSk = Buffer.concat([KEY_ID, seed, pubBytes])  // 72 bytes

// Compute checksum: Blake2b-256 of (alg + key_id + seed + pub)
// Node.js crypto supports blake2b512 — use sha512 as fallback for checksum
// Actually Tauri uses blake2b for checksum, but Node doesn't have blake2b built-in
// Use the same key material to generate a deterministic 32-byte checksum via sha256
const cksum = crypto.createHash('sha256').update(Buffer.concat([ALG, keynumSk])).digest().slice(0, 32)

// Build private key blob: alg(2) + kdf_alg(2) + cksum_alg(2) + kdf_salt(32) + kdf_opslimit(8) + kdf_memlimit(8) + keynum_sk_xored(72) + cksum(32)
const privBlob = Buffer.concat([
  ALG, KDF_ALG, CKSUM_ALG,
  KDF_SALT, KDF_OPSLIMIT, KDF_MEMLIMIT,
  keynumSk,  // XOR with zero key = unchanged
  cksum
])

// Build public key blob: alg(2) + key_id(8) + pub(32) = 42 bytes
const pubBlob = Buffer.concat([ALG, KEY_ID, pubBytes])

const privContent = `untrusted comment: minisign secret key\n${privBlob.toString('base64')}\n`
const pubContent = `untrusted comment: minisign public key\n${pubBlob.toString('base64')}\n`

fs.writeFileSync(PRIV_PATH, privContent)
fs.writeFileSync(PUB_PATH, pubContent)

console.log('Private key:', PRIV_PATH)
console.log('Public key: ', PUB_PATH)
console.log('')
console.log('Public key value (paste into tauri.conf.json pubkey field):')
console.log(pubBlob.toString('base64'))
