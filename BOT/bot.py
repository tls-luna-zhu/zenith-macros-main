#!/usr/bin/env python3
"""
Zenith Macros — Discord bot
Calls the deployed Flask backend at API_BASE.

Environment variables:
  DISCORD_BOT_TOKEN    - Discord bot token (required)
  API_BASE             - Backend URL, default https://zenithmacros.store
  BOT_API_TOKEN        - Shared secret matching BOT_API_TOKEN on the server
  OWNER_DISCORD_ID     - Owner's Discord user ID
  ADMIN_DISCORD_IDS    - Comma-separated admin Discord IDs
"""
from __future__ import annotations

import os
import sys

import discord
import requests
from discord import app_commands

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BOT_TOKEN     = os.environ.get("DISCORD_BOT_TOKEN", "")
API_BASE      = os.environ.get("API_BASE", "https://zenithmacros.store").rstrip("/")
BOT_API_TOKEN = os.environ.get("BOT_API_TOKEN", "dev-bot-token-change-me")

OWNER_ID          = int(os.environ.get("OWNER_DISCORD_ID", "1292582729040396351"))
_raw              = os.environ.get("ADMIN_DISCORD_IDS", str(OWNER_ID))
ADMIN_IDS         = {int(x.strip()) for x in _raw.split(",") if x.strip().isdigit()}
ADMIN_IDS.add(OWNER_ID)
CUSTOMER_ROLE_ID  = int(os.environ.get("CUSTOMER_ROLE_ID", "0"))

DASHBOARD_URL = "https://zenithmacros.store/dashboard.html"


def _headers():
    return {"Authorization": f"Bearer {BOT_API_TOKEN}", "Content-Type": "application/json"}


def _get(path: str, **params):
    return requests.get(f"{API_BASE}{path}", headers=_headers(), params=params, timeout=30)


def _post(path: str, body: dict):
    return requests.post(f"{API_BASE}{path}", headers=_headers(), json=body, timeout=30)


def is_admin(uid: int) -> bool:
    return uid in ADMIN_IDS


def is_owner(uid: int) -> bool:
    return uid == OWNER_ID


async def _set_customer_role(guild: discord.Guild | None, user: discord.User, add: bool) -> str:
    """Add or remove the customer role. Returns a short status string for logging."""
    if not guild or not CUSTOMER_ROLE_ID:
        return ""
    role = guild.get_role(CUSTOMER_ROLE_ID)
    if not role:
        return f" (⚠️ customer role {CUSTOMER_ROLE_ID} not found)"
    try:
        member = guild.get_member(user.id) or await guild.fetch_member(user.id)
    except discord.NotFound:
        return f" (⚠️ {user.mention} not in server)"
    except Exception as e:
        return f" (⚠️ role error: {e})"
    try:
        if add:
            await member.add_roles(role, reason="License granted")
        else:
            await member.remove_roles(role, reason="License revoked")
        return f" ({'✅ customer role added' if add else '✅ customer role removed'})"
    except discord.Forbidden:
        return " (⚠️ missing Manage Roles permission)"
    except Exception as e:
        return f" (⚠️ role error: {e})"


def _ts(v) -> str:
    if not v:
        return "—"
    try:
        return f"<t:{int(v)}:R>"
    except Exception:
        return str(v)


def _api_err(r) -> str:
    try:
        return r.json().get("error", "unknown error")
    except Exception:
        return f"HTTP {r.status_code}"


intents = discord.Intents.default()
intents.message_content = False
intents.members = True

client = discord.Client(intents=intents)
tree   = app_commands.CommandTree(client)


# ===========================================================================
# USER COMMANDS
# ===========================================================================

@tree.command(name="claimkey", description="Link your old Zenith license key to your Discord account")
@app_commands.describe(key="Your legacy license key")
async def claimkey(interaction: discord.Interaction, key: str):
    await interaction.response.defer(ephemeral=True)
    r = _post("/api/bot/discord/claim", {"discord_id": str(interaction.user.id), "key": key.strip().upper()})
    try:
        data = r.json()
    except Exception:
        await interaction.followup.send("⚠️ API error — please try again or open a ticket.", ephemeral=True)
        return

    if not data.get("ok"):
        err = data.get("error", "unknown")
        if err == "already_linked":
            embed = discord.Embed(
                title="Already Linked",
                description=(
                    f"Your Discord account already has an active **{data.get('existing_plan', '—')}** license.\n\n"
                    f"Key: `{data.get('existing_key', '—')}`\n\n"
                    f"Log in at your [dashboard]({DASHBOARD_URL}) to view it."
                ),
                color=0xffce72,
            )
        elif err == "not_found":
            embed = discord.Embed(
                title="Key Not Found",
                description=(
                    f"The key `{key.strip().upper()}` wasn't found or is already linked to another account.\n\n"
                    "Double-check the key and try again. If this persists, open a support ticket."
                ),
                color=0xf87171,
            )
        else:
            embed = discord.Embed(title="Claim Failed", description=f"Error: `{err}`", color=0xf87171)
        await interaction.followup.send(embed=embed, ephemeral=True)
        return

    embed = discord.Embed(
        title="✅ License Linked",
        description=(
            f"Your **{data.get('plan', '—')}** license has been linked to your Discord account.\n\n"
            f"Key: `{data.get('key', '—')}`\n"
            f"Status: **{data.get('status', 'active')}**\n\n"
            f"Log in at your [dashboard]({DASHBOARD_URL}) to view your full license details."
        ),
        color=0x57db95,
    )
    await interaction.followup.send(embed=embed, ephemeral=True)


# ===========================================================================
# ADMIN — LICENSE MANAGEMENT
# ===========================================================================

@tree.command(name="grantlicense", description="[Admin] Grant a new license to a Discord user")
@app_commands.describe(user="Target Discord user", plan="monthly or lifetime")
@app_commands.choices(plan=[
    app_commands.Choice(name="Monthly ($10/mo)", value="monthly"),
    app_commands.Choice(name="Lifetime ($25)",   value="lifetime"),
])
async def grantlicense(interaction: discord.Interaction, user: discord.User, plan: app_commands.Choice[str]):
    if not is_admin(interaction.user.id):
        await interaction.response.send_message("❌ Admins only.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)

    r = _post("/api/bot/discord/grant", {"discord_id": str(user.id), "plan": plan.value})
    try:
        data = r.json()
    except Exception:
        await interaction.followup.send(f"⚠️ API error ({r.status_code}).")
        return
    if not data.get("ok"):
        await interaction.followup.send(f"❌ Failed: `{_api_err(r)}`")
        return

    role_note = await _set_customer_role(interaction.guild, user, add=True)
    embed = discord.Embed(title="✅ License Granted", color=0x7c3aed)
    embed.add_field(name="User",  value=f"{user.mention} (`{user.id}`)", inline=False)
    embed.add_field(name="Plan",  value=plan.name,                        inline=True)
    embed.add_field(name="Key",   value=f"`{data.get('key')}`",           inline=False)
    embed.set_footer(text=f"License linked to their dashboard account.{role_note}")
    await interaction.followup.send(embed=embed)


@tree.command(name="checklicense", description="[Admin] View licenses linked to a Discord user")
@app_commands.describe(user="Target Discord user")
async def checklicense(interaction: discord.Interaction, user: discord.User):
    if not is_admin(interaction.user.id):
        await interaction.response.send_message("❌ Admins only.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)

    r = _get("/api/bot/discord/licenses", discord_id=str(user.id))
    try:
        data = r.json()
    except Exception:
        await interaction.followup.send(f"⚠️ API error ({r.status_code}).")
        return
    if not data.get("ok"):
        await interaction.followup.send(f"❌ Error: `{_api_err(r)}`")
        return

    licenses = data.get("licenses", [])
    if not licenses:
        await interaction.followup.send(f"No licenses found for {user.mention}.")
        return

    embed = discord.Embed(
        title=f"Licenses — {user.display_name}",
        description=f"**{len(licenses)}** license(s) linked to `{user.id}`",
        color=0x7c3aed,
    )
    for lic in licenses[:6]:
        active     = lic.get("active", True)
        tier       = lic.get("tier", "—")
        hwid       = lic.get("hwid") or "Unbound"
        expires    = lic.get("expires_at") or "Never"
        status_dot = "🟢" if active else "🔴"
        embed.add_field(
            name=f"`{lic['key']}`",
            value=(
                f"{status_dot} **{tier}** — {'Active' if active else 'Revoked'}\n"
                f"HWID: `{hwid}`\n"
                f"Expires: {expires}"
            ),
            inline=False,
        )
    await interaction.followup.send(embed=embed)


@tree.command(name="revokelicense", description="[Admin] Revoke license(s) for a Discord user")
@app_commands.describe(user="Target Discord user", key="Specific key to revoke (leave blank = all)")
async def revokelicense(interaction: discord.Interaction, user: discord.User, key: str | None = None):
    if not is_admin(interaction.user.id):
        await interaction.response.send_message("❌ Admins only.", ephemeral=True)
        return

    scope = f"key `{key}`" if key else "**ALL** licenses"

    class ConfirmView(discord.ui.View):
        def __init__(self):
            super().__init__(timeout=30)
            self.confirmed = False

        @discord.ui.button(label="Confirm Revoke", style=discord.ButtonStyle.danger)
        async def confirm(self, i: discord.Interaction, _: discord.ui.Button):
            self.confirmed = True
            self.stop()
            await i.response.defer()

        @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
        async def cancel(self, i: discord.Interaction, _: discord.ui.Button):
            self.stop()
            await i.response.edit_message(content="Cancelled.", view=None)

    view = ConfirmView()
    await interaction.response.send_message(
        f"⚠️ Revoke {scope} for {user.mention}?",
        view=view, ephemeral=True,
    )
    await view.wait()
    if not view.confirmed:
        return

    r = _post("/api/bot/discord/revoke", {"discord_id": str(user.id), "key": key or ""})
    try:
        data = r.json()
    except Exception:
        await interaction.edit_original_response(content=f"⚠️ API error ({r.status_code}).", view=None)
        return
    if not data.get("ok"):
        await interaction.edit_original_response(content=f"❌ Failed: `{_api_err(r)}`", view=None)
        return

    role_note = await _set_customer_role(interaction.guild, user, add=False)
    await interaction.edit_original_response(
        content=f"✅ Revoked **{data.get('revoked', 0)}** license(s) for {user.mention}.{role_note}",
        view=None,
    )


@tree.command(name="upgradelicense", description="[Admin] Upgrade a user's monthly license to lifetime")
@app_commands.describe(user="Target Discord user", key="Specific key to upgrade (leave blank = all monthly)")
async def upgradelicense(interaction: discord.Interaction, user: discord.User, key: str | None = None):
    if not is_admin(interaction.user.id):
        await interaction.response.send_message("❌ Admins only.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)

    r = _post("/api/bot/discord/upgrade", {"discord_id": str(user.id), "key": key or ""})
    try:
        data = r.json()
    except Exception:
        await interaction.followup.send(f"⚠️ API error ({r.status_code}).")
        return
    if not data.get("ok"):
        await interaction.followup.send(f"❌ Failed: `{_api_err(r)}`")
        return

    count = data.get("upgraded", 0)
    if count == 0:
        await interaction.followup.send(f"No eligible licenses found for {user.mention}.")
        return

    embed = discord.Embed(title="✅ License Upgraded to Lifetime", color=0x7c3aed)
    embed.add_field(name="User",     value=f"{user.mention} (`{user.id}`)", inline=False)
    embed.add_field(name="Upgraded", value=f"**{count}** license(s)",       inline=True)
    for lic in data.get("licenses", [])[:3]:
        embed.add_field(name="Key", value=f"`{lic['key']}`", inline=False)
    embed.set_footer(text="License is now lifetime — no further billing.")
    await interaction.followup.send(embed=embed)


@tree.command(name="resetuserhwid", description="[Admin] Reset HWID for a user's license(s)")
@app_commands.describe(user="Target Discord user", key="Specific key (leave blank = all)")
async def resetuserhwid(interaction: discord.Interaction, user: discord.User, key: str | None = None):
    if not is_admin(interaction.user.id):
        await interaction.response.send_message("❌ Admins only.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)

    r = _post("/api/bot/discord/reset-hwid", {"discord_id": str(user.id), "key": key or ""})
    try:
        data = r.json()
    except Exception:
        await interaction.followup.send(f"⚠️ API error ({r.status_code}).")
        return
    if not data.get("ok"):
        await interaction.followup.send(f"❌ Failed: `{_api_err(r)}`")
        return

    count = data.get("reset", 0)
    scope = f"key `{key}`" if key else "all licenses"
    await interaction.followup.send(
        f"✅ Reset HWID for **{count}** license(s) ({scope}) for {user.mention}."
    )


# ===========================================================================
# ADMIN — AFFILIATE MANAGEMENT
# ===========================================================================

@tree.command(name="checkaffiliate", description="[Admin] Look up affiliate info and licenses for a user")
@app_commands.describe(user="Discord user")
async def checkaffiliate(interaction: discord.Interaction, user: discord.User):
    if not is_admin(interaction.user.id):
        await interaction.response.send_message("❌ Admins only.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)

    r = _get("/api/bot/discord/licenses", discord_id=str(user.id))
    try:
        data = r.json()
    except Exception:
        await interaction.followup.send(f"⚠️ API error ({r.status_code}).")
        return
    if not data.get("ok"):
        await interaction.followup.send(f"❌ Error: `{_api_err(r)}`")
        return

    licenses = data.get("licenses", [])
    if not licenses:
        await interaction.followup.send(f"No licenses found for {user.mention}.")
        return

    embed = discord.Embed(
        title=f"Account — {user.display_name}",
        description=f"Discord ID: `{user.id}`",
        color=0x7c3aed,
    )
    for lic in licenses[:4]:
        aff = lic.get("affiliate_code") or "—"
        active = lic.get("active", True)
        embed.add_field(
            name=f"`{lic['key']}`",
            value=(
                f"Plan: **{lic.get('tier', '—')}** — {'🟢 Active' if active else '🔴 Revoked'}\n"
                f"Affiliate code: `{aff}`\n"
                f"HWID: `{lic.get('hwid') or 'Unbound'}`\n"
                f"Expires: {lic.get('expires_at') or 'Never'}"
            ),
            inline=False,
        )
    await interaction.followup.send(embed=embed)


@tree.command(name="setaffiliate", description="[Owner] Set or clear a user's affiliate referral code")
@app_commands.describe(user="Target user", code="New code (4-32 lowercase alphanumeric) — leave blank to clear")
async def setaffiliate(interaction: discord.Interaction, user: discord.User, code: str = ""):
    if not is_owner(interaction.user.id):
        await interaction.response.send_message("❌ Owner only.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)

    clean = code.strip().lower()
    if clean and (not clean.isalnum() or not (4 <= len(clean) <= 32)):
        await interaction.followup.send("❌ Code must be 4-32 lowercase alphanumeric characters (or leave blank to clear).")
        return

    r = _post("/api/bot/discord/set-affiliate", {"discord_id": str(user.id), "affiliate_code": clean})
    try:
        data = r.json()
    except Exception:
        await interaction.followup.send(f"⚠️ API error ({r.status_code}).")
        return
    if not data.get("ok"):
        await interaction.followup.send(f"❌ Failed: `{_api_err(r)}`")
        return

    if clean:
        msg = f"✅ Affiliate code set to `{clean}` for {user.mention} ({data.get('updated', 0)} license(s) updated)."
    else:
        msg = f"✅ Affiliate code cleared for {user.mention} ({data.get('updated', 0)} license(s) updated)."
    await interaction.followup.send(msg)


# ===========================================================================
# TICKET PANEL
# ===========================================================================

TICKET_CATEGORY_ID = int(os.environ.get("TICKET_CATEGORY_ID", "0"))
TICKET_STAFF_ROLE_ID = int(os.environ.get("TICKET_STAFF_ROLE_ID", "0"))

TICKET_OPTIONS = [
    discord.SelectOption(
        label="General Support",
        value="general",
        description="Questions, account issues, or anything else",
        emoji="🎫",
    ),
    discord.SelectOption(
        label="License Issue",
        value="license",
        description="Problems with your license key or access",
        emoji="🔑",
    ),
    discord.SelectOption(
        label="Bug Report",
        value="bug",
        description="Report a bug or unexpected behavior",
        emoji="🐛",
    ),
    discord.SelectOption(
        label="DonutSMP Pay",
        value="donutsmp",
        description="Purchase a license via DonutSMP payment",
        emoji="🍩",
    ),
]


class TicketSelect(discord.ui.Select):
    def __init__(self):
        super().__init__(
            placeholder="Please choose an option",
            min_values=1,
            max_values=1,
            options=TICKET_OPTIONS,
            custom_id="zenith:ticket_select",
        )

    async def callback(self, interaction: discord.Interaction):
        value = self.values[0]

        if value == "donutsmp":
            # Ask which license they want before opening the ticket
            class LicenseSelect(discord.ui.Select):
                def __init__(self_inner):
                    super().__init__(
                        placeholder="Which license are you purchasing?",
                        min_values=1,
                        max_values=1,
                        options=[
                            discord.SelectOption(label="Monthly ($10/mo)", value="monthly", emoji="📅"),
                            discord.SelectOption(label="Lifetime ($25)", value="lifetime", emoji="♾️"),
                        ],
                        custom_id="zenith:donut_license_select",
                    )

                async def callback(self_inner, i: discord.Interaction):
                    chosen = self_inner.values[0]
                    await _open_ticket(
                        i,
                        topic="DonutSMP Pay",
                        description=(
                            f"**DonutSMP Pay — {chosen.capitalize()} License**\n\n"
                            f"User {i.user.mention} wants to purchase a **{chosen}** license via DonutSMP.\n\n"
                            "Staff: please process the DonutSMP payment and grant the license once confirmed."
                        ),
                    )

            view = discord.ui.View(timeout=120)
            view.add_item(LicenseSelect())
            await interaction.response.send_message(
                embed=discord.Embed(
                    title="🍩 DonutSMP Pay",
                    description=(
                        "Please select which license you'd like to purchase.\n"
                        "A ticket will then be opened for you automatically."
                    ),
                    color=0x7c3aed,
                ),
                view=view,
                ephemeral=True,
            )
            return

        # All other options open a ticket immediately
        topic_map = {
            "general": "General Support",
            "license": "License Issue",
            "bug":     "Bug Report",
        }
        desc_map = {
            "general": f"User {interaction.user.mention} opened a **General Support** ticket.\n\nPlease describe your issue and a staff member will assist you shortly.",
            "license": f"User {interaction.user.mention} is experiencing a **License Issue**.\n\nPlease describe the problem and a staff member will assist you shortly.",
            "bug":     f"User {interaction.user.mention} wants to **Report a Bug**.\n\nPlease describe the issue in detail (steps to reproduce, what you expected vs what happened).",
        }
        await _open_ticket(
            interaction,
            topic=topic_map.get(value, value),
            description=desc_map.get(value, ""),
        )


async def _open_ticket(
    interaction: discord.Interaction,
    topic: str,
    description: str,
):
    guild = interaction.guild
    if guild is None:
        await interaction.response.send_message("❌ This only works in a server.", ephemeral=True)
        return

    # Check for existing open ticket
    existing = discord.utils.get(
        guild.text_channels,
        name=f"ticket-{interaction.user.name.lower().replace(' ', '-')}",
    )
    if existing:
        await interaction.response.send_message(
            f"❌ You already have an open ticket: {existing.mention}", ephemeral=True
        )
        return

    # Build permission overwrites
    overwrites = {
        guild.default_role: discord.PermissionOverwrite(read_messages=False),
        interaction.user:   discord.PermissionOverwrite(read_messages=True, send_messages=True, attach_files=True),
        guild.me:           discord.PermissionOverwrite(read_messages=True, send_messages=True, manage_channels=True),
    }
    if TICKET_STAFF_ROLE_ID:
        staff_role = guild.get_role(TICKET_STAFF_ROLE_ID)
        if staff_role:
            overwrites[staff_role] = discord.PermissionOverwrite(read_messages=True, send_messages=True)

    category = guild.get_channel(TICKET_CATEGORY_ID) if TICKET_CATEGORY_ID else None

    try:
        channel = await guild.create_text_channel(
            name=f"ticket-{interaction.user.name.lower().replace(' ', '-')}",
            overwrites=overwrites,
            category=category,
            reason=f"Ticket opened by {interaction.user} — {topic}",
        )
    except discord.Forbidden:
        await interaction.response.send_message(
            "❌ I don't have permission to create channels.", ephemeral=True
        )
        return

    # Close button
    class CloseView(discord.ui.View):
        def __init__(self):
            super().__init__(timeout=None)

        @discord.ui.button(label="Close Ticket", style=discord.ButtonStyle.danger, emoji="🔒", custom_id="zenith:close_ticket")
        async def close(self, i: discord.Interaction, _: discord.ui.Button):
            await i.response.send_message("🔒 Closing ticket...", ephemeral=True)
            await channel.delete(reason=f"Ticket closed by {i.user}")

    embed = discord.Embed(
        title=f"🎫 {topic}",
        description=description,
        color=0x7c3aed,
    )
    embed.set_footer(text=f"Zenith Macros Support • opened by {interaction.user.display_name}")
    await channel.send(
        content=f"{interaction.user.mention}" + (f" <@&{TICKET_STAFF_ROLE_ID}>" if TICKET_STAFF_ROLE_ID else ""),
        embed=embed,
        view=CloseView(),
    )

    await interaction.response.send_message(
        f"✅ Your ticket has been created: {channel.mention}", ephemeral=True
    )


class TicketPanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(TicketSelect())


@tree.command(name="ticketpanel", description="[Admin] Post the support ticket panel in this channel")
async def ticketpanel(interaction: discord.Interaction):
    if not is_admin(interaction.user.id):
        await interaction.response.send_message("❌ Admins only.", ephemeral=True)
        return

    embed = discord.Embed(
        title="Zenith Macros Support",
        description=(
            "Please choose an option below. Choosing an option will give you a guide on how to solve the issue. "
            "If your issue isn't resolved, a ticket will be opened automatically."
        ),
        color=0x7c3aed,
    )
    embed.set_footer(text="Zenith Macros")
    await interaction.channel.send(embed=embed, view=TicketPanelView())
    await interaction.response.send_message("✅ Ticket panel posted.", ephemeral=True)


# ===========================================================================
# READY
# ===========================================================================

@client.event
async def on_ready():
    client.add_view(TicketPanelView())  # re-register persistent view after restart
    await tree.sync()
    cmds = [c.name for c in tree.get_commands()]
    print(f"[zenith-bot] Logged in as {client.user} (id={client.user.id})")
    print(f"[zenith-bot] API base: {API_BASE}")
    print(f"[zenith-bot] Synced {len(cmds)} commands: {', '.join(sorted(cmds))}")


def main():
    if not BOT_TOKEN:
        print("ERROR: Set DISCORD_BOT_TOKEN environment variable.", file=sys.stderr)
        sys.exit(1)
    client.run(BOT_TOKEN)


if __name__ == "__main__":
    main()
