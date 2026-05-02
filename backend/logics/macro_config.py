"""
Returns the encrypted premium macro configuration for a validated user.

The configuration JSON is encrypted with the user's per-user AES-256-GCM key
so that only a client who has successfully decrypted their user_enc_key can
access the premium config blob.
"""

import base64
import json

from utils.crypto import aes256_gcm_encrypt


# ---------------------------------------------------------------------------
# Default premium configuration template
# ---------------------------------------------------------------------------

_PREMIUM_CONFIG_TEMPLATE: dict = {
    'version': '2026.1',
    'features': {
        'autoClicker':      True,
        'macroRecorder':    True,
        'focusLock':        True,
        'discordRpc':       True,
        'profiles':         True,
        'advancedBindings': True,
    },
    'limits': {
        'maxProfiles':    50,
        'maxMacros':      200,
        'clickInterval':  1,
    },
    'tier_note': 'This config blob is encrypted with your personal key.',
}


def get_encrypted_config(user_enc_key: bytes, license) -> dict:
    """Encrypt the premium macro config for *license* and return a transport dict.

    Args:
        user_enc_key: The 32-byte per-user AES key (already decrypted on the
                      server side from the stored hex).
        license:      The :class:`~models.License` instance (used to populate
                      tier-specific fields).

    Returns:
        A dict with ``enc_config`` (base64), ``iv`` (base64), and ``tier``.
    """
    if len(user_enc_key) != 32:
        raise ValueError('user_enc_key must be exactly 32 bytes')

    config = dict(_PREMIUM_CONFIG_TEMPLATE)
    config['tier'] = license.tier

    # Lifetime users get an additional courtesy flag
    if license.tier == 'lifetime':
        config['features']['lifetimeBadge'] = True

    plaintext = json.dumps(config, separators=(',', ':')).encode()
    ct, iv = aes256_gcm_encrypt(user_enc_key, plaintext)

    return {
        'enc_config': base64.b64encode(ct).decode(),
        'iv':         base64.b64encode(iv).decode(),
        'tier':       license.tier,
    }
