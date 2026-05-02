"""
Discord role management helpers.

Gives or removes the configured DISCORD_CUSTOMER_ROLE_ID from a guild member
using the bot token. All failures are silently swallowed — role sync is
best-effort and must never block a purchase or revocation.
"""

from __future__ import annotations

import logging
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

_log = logging.getLogger(__name__)


def _manage_customer_role(discord_id: str, add: bool, *, bot_token: str, guild_id: str, role_id: str) -> None:
    """PUT or DELETE the customer role for a single guild member."""
    if not bot_token or not guild_id or not role_id or not discord_id:
        return
    url = f"https://discord.com/api/v10/guilds/{guild_id}/members/{discord_id}/roles/{role_id}"
    method = "PUT" if add else "DELETE"
    try:
        req = Request(url, data=b"", headers={
            "Authorization": f"Bot {bot_token}",
            "Content-Type": "application/json",
            "User-Agent": "DiscordBot (https://zenithmacros.store, 1.0)",
            "X-Audit-Log-Reason": "Zenith key active" if add else "Zenith key revoked/expired",
        }, method=method)
        with urlopen(req, timeout=8) as resp:
            resp.read()
    except HTTPError as exc:
        body = exc.read(512).decode(errors='replace')
        _log.error('[discord_roles] HTTP %s %s discord_id=%s body=%s', exc.code, method, discord_id, body)
        print(f'[discord_roles] HTTP {exc.code} {method} discord_id={discord_id} body={body}', file=sys.stderr)
    except Exception as exc:
        _log.error('[discord_roles] %s %s discord_id=%s error=%s', method, url, discord_id, exc)
        print(f'[discord_roles] {method} failed discord_id={discord_id} error={exc}', file=sys.stderr)


def grant_customer_role(discord_id: str, app_config: dict) -> None:
    _manage_customer_role(
        discord_id, add=True,
        bot_token=str(app_config.get("DISCORD_BOT_TOKEN", "") or "").strip(),
        guild_id=str(app_config.get("DISCORD_GUILD_ID", "") or "").strip(),
        role_id=str(app_config.get("DISCORD_CUSTOMER_ROLE_ID", "") or "").strip(),
    )


def revoke_customer_role(discord_id: str, app_config: dict) -> None:
    _manage_customer_role(
        discord_id, add=False,
        bot_token=str(app_config.get("DISCORD_BOT_TOKEN", "") or "").strip(),
        guild_id=str(app_config.get("DISCORD_GUILD_ID", "") or "").strip(),
        role_id=str(app_config.get("DISCORD_CUSTOMER_ROLE_ID", "") or "").strip(),
    )


def grant_standalone_role(discord_id: str, app_config: dict) -> None:
    """Grant the Individual Macros role (DISCORD_STANDALONE_ROLE_ID) after a standalone purchase."""
    _manage_customer_role(
        discord_id, add=True,
        bot_token=str(app_config.get("DISCORD_BOT_TOKEN", "") or "").strip(),
        guild_id=str(app_config.get("DISCORD_GUILD_ID", "") or "").strip(),
        role_id=str(app_config.get("DISCORD_STANDALONE_ROLE_ID", "") or "").strip(),
    )


def revoke_standalone_role(discord_id: str, app_config: dict) -> None:
    _manage_customer_role(
        discord_id, add=False,
        bot_token=str(app_config.get("DISCORD_BOT_TOKEN", "") or "").strip(),
        guild_id=str(app_config.get("DISCORD_GUILD_ID", "") or "").strip(),
        role_id=str(app_config.get("DISCORD_STANDALONE_ROLE_ID", "") or "").strip(),
    )
