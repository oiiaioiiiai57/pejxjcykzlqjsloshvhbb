import discord
from discord import app_commands
from discord.ext import commands
import os
import json
import random
import string
import asyncio
import time
from github import Github, GithubException, Auth

# ------------------ CONFIG ------------------
TOKEN        = os.getenv("TOKEN")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME    = "chevalier577pro/gen-bot"

FREE_CHANNEL    = 1479204587104895060
PREMIUM_CHANNEL = 1479080682616520718
PAID_CHANNEL    = 1479080682616520717
TICKET_CATEGORY = 1479080682784555134
LOG_CHANNEL     = 1479239531499880628

STAFF_ROLE    = 1479080681983316004
HELPER_ROLE   = 1479080681983316008
ADDV_ROLE     = 1479080681996030042   # only this role can use /addv
MODERATOR_ROLES = [
    1479080681983316006,
    1479080681983316007,
    1479080681996030042,
    1479080681996030043,
]

# Vouch promotion tiers  (threshold -> list of role IDs to grant)
VOUCH_TIERS = [
    (40,  [1479080681983316005, 1479080681983316008]),
    (60,  [1479080681983316006]),
    (100, [1479080681983316007]),
]

# ------------------ COLORS ------------------
C_SUCCESS = 0x57F287
C_ERROR   = 0xED4245
C_WARN    = 0xFEE75C
C_INFO    = 0x5865F2
C_LOG     = 0x2B2D31
C_FREE    = 0x57F287
C_PREMIUM = 0xA855F7
C_PAID    = 0xFFD166

TIER_COLOR = {"free": C_FREE, "premium": C_PREMIUM, "paid": C_PAID}
TIER_EMOJI = {"free": "🟢", "premium": "🟣", "paid": "🟡"}

# ------------------ INIT ------------------
intents = discord.Intents.all()
bot     = commands.Bot(command_prefix="$$$_unused", intents=intents)  # prefix unused, slash only
tree    = bot.tree

github_client = Github(auth=Auth.Token(GITHUB_TOKEN))
repo = github_client.get_repo(REPO_NAME)

ACCOUNTS_DIR       = "accounts"
PENDING_FILE       = "pending.json"
STATS_FILE         = "stats.json"
COOLDOWN_FILE      = "cooldowns.json"
SEND_COOLDOWN_FILE = "send_cooldown.json"
VOUCHES_FILE       = "vouches.json"

# ------------------ UTILS ------------------
def normalize(service: str) -> str:
    return service.capitalize()

def is_mod(member: discord.Member) -> bool:
    return any(role.id in MODERATOR_ROLES for role in member.roles)

def is_helper(member: discord.Member) -> bool:
    return any(role.id == HELPER_ROLE for role in member.roles)

def has_addv_role(member: discord.Member) -> bool:
    return any(role.id == ADDV_ROLE for role in member.roles)

def github_read(path: str) -> list[str]:
    try:
        file = repo.get_contents(path)
        return [line.strip() for line in file.decoded_content.decode().splitlines() if line.strip()]
    except GithubException as e:
        print(f"Error reading {path}: {e}")
        return []

def github_write(path: str, data: list[str]):
    content = "\n".join(data) + "\n"
    try:
        file = repo.get_contents(path)
        repo.update_file(file.path, "Update stock", content, file.sha)
    except GithubException:
        repo.create_file(path, "Create stock file", content)

def load_json(path: str) -> dict:
    try:
        file = repo.get_contents(path)
        return json.loads(file.decoded_content.decode())
    except (GithubException, json.JSONDecodeError) as e:
        print(f"Error loading {path}: {e}")
        return {}

def save_json(path: str, data: dict):
    content = json.dumps(data, indent=4) + "\n"
    try:
        file = repo.get_contents(path)
        repo.update_file(file.path, "Update JSON", content, file.sha)
    except GithubException:
        repo.create_file(path, "Create JSON file", content)

# ------------------ EMBED HELPERS ------------------
def embed_success(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=f"✅  {title}", description=description, color=C_SUCCESS)
    e.set_footer(text="Gen Bot")
    return e

def embed_error(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=f"❌  {title}", description=description, color=C_ERROR)
    e.set_footer(text="Gen Bot")
    return e

def embed_warn(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=f"⚠️  {title}", description=description, color=C_WARN)
    e.set_footer(text="Gen Bot")
    return e

def embed_log(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=title, description=description, color=C_LOG)
    e.timestamp = discord.utils.utcnow()
    return e

# ------------------ LOG ------------------
async def send_log(guild: discord.Guild, embed: discord.Embed):
    channel = guild.get_channel(LOG_CHANNEL)
    if channel:
        await channel.send(embed=embed)

# ------------------ COOLDOWNS ------------------
def check_cooldown(user_id: int, tier: str) -> tuple[bool, int]:
    data     = load_json(COOLDOWN_FILE)
    user_key = str(user_id)
    if user_key not in data:
        data[user_key] = {"free": [], "premium": [], "paid": []}

    limits  = {"free": (1, 3600), "premium": (3, 3600), "paid": (10, 3600)}
    max_use, period = limits[tier]
    now  = int(time.time())
    uses = [t for t in data[user_key][tier] if now - t < period]

    if len(uses) >= max_use:
        return False, period - (now - uses[0])

    uses.append(now)
    data[user_key][tier] = uses
    save_json(COOLDOWN_FILE, data)
    return True, 0

# ------------------ VOUCH HELPERS ------------------
def get_vouches(user_id: int) -> int:
    return load_json(VOUCHES_FILE).get(str(user_id), 0)

def add_vouch(user_id: int, amount: int = 1) -> int:
    """Add `amount` vouches (default 1) and return new total. Never resets."""
    data      = load_json(VOUCHES_FILE)
    key       = str(user_id)
    data[key] = data.get(key, 0) + amount
    save_json(VOUCHES_FILE, data)
    return data[key]

def next_vouch_tier(current: int) -> tuple[int, list[int]] | None:
    for threshold, role_ids in VOUCH_TIERS:
        if current < threshold:
            return threshold, role_ids
    return None

async def check_and_promote(guild: discord.Guild, member: discord.Member, vouches: int):
    """Grant roles for every milestone that has been reached or passed."""
    for threshold, role_ids in VOUCH_TIERS:
        if vouches >= threshold:
            newly_granted = []
            for role_id in role_ids:
                role = guild.get_role(role_id)
                if role and role not in member.roles:
                    await member.add_roles(role, reason=f"Reached {threshold} vouches")
                    newly_granted.append(role_id)
            if newly_granted:
                role_mentions = " ".join(f"<@&{rid}>" for rid in newly_granted)
                log       = embed_log("🎉  Promotion", f"{member.mention} has been promoted to {role_mentions} with **{vouches} vouches**!")
                log.color = C_PREMIUM
                await send_log(guild, log)

# ------------------ READY ------------------
@bot.event
async def on_ready():
    await tree.sync()
    print(f"Bot online: {bot.user} — slash commands synced.")
    await bot.change_presence(activity=discord.Game("/help • Gen Bot"))

# ================================================================
#  SLASH COMMANDS
# ================================================================

# Tier choices reused across commands
TIER_CHOICES = [
    app_commands.Choice(name="🟢 Free",    value="free"),
    app_commands.Choice(name="🟣 Premium", value="premium"),
    app_commands.Choice(name="🟡 Paid",    value="paid"),
]

# ------------------ /gen ------------------
@tree.command(name="gen", description="Generate an account")
@app_commands.describe(tier="Account tier", service="Service name (e.g. Netflix)")
@app_commands.choices(tier=TIER_CHOICES)
async def gen(interaction: discord.Interaction, tier: app_commands.Choice[str], service: str):
    await interaction.response.defer()

    t = tier.value
    channels = {"free": FREE_CHANNEL, "premium": PREMIUM_CHANNEL, "paid": PAID_CHANNEL}

    if interaction.channel_id != channels[t]:
        return await interaction.followup.send(embed=embed_error(
            "Wrong Channel", f"Please use this command in the correct channel for the **{t}** tier."
        ))

    member = interaction.guild.get_member(interaction.user.id)
    if not is_mod(member):
        allowed, remaining = check_cooldown(interaction.user.id, t)
        if not allowed:
            minutes, seconds = divmod(remaining, 60)
            return await interaction.followup.send(embed=embed_warn(
                "Cooldown Active",
                f"Please wait **{minutes}m {seconds}s** before generating again."
            ))

    service = normalize(service)
    path    = f"{ACCOUNTS_DIR}/{t}/{service}.txt"
    stock   = github_read(path)

    if not stock:
        return await interaction.followup.send(embed=embed_error(
            "Out of Stock", f"No **{service}** accounts available in the **{t}** tier."
        ))

    account = stock.pop(0)
    github_write(path, stock)

    code    = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    pending = load_json(PENDING_FILE)
    pending[code] = {"account": account, "user": interaction.user.id}
    save_json(PENDING_FILE, pending)

    category = bot.get_channel(TICKET_CATEGORY)
    if not category or not isinstance(category, discord.CategoryChannel):
        return await interaction.followup.send(embed=embed_error(
            "Category Not Found", "The ticket category could not be found."
        ))

    overwrites = {
        interaction.guild.default_role: discord.PermissionOverwrite(read_messages=False),
        interaction.user:               discord.PermissionOverwrite(read_messages=True, send_messages=True),
        interaction.guild.me:           discord.PermissionOverwrite(read_messages=True, send_messages=True),
    }
    ticket_name = f"{service.lower()}-{interaction.user.name.lower()}-{random.randint(1000, 9999)}"
    ticket      = await category.create_text_channel(name=ticket_name, overwrites=overwrites)

    ticket_embed = discord.Embed(
        title="🎟️  Generation Ticket",
        description="Your account has been reserved! A staff member will validate your ticket shortly.",
        color=TIER_COLOR[t]
    )
    ticket_embed.add_field(name="👤 Member",  value=interaction.user.mention,              inline=True)
    ticket_embed.add_field(name="📦 Service", value=f"**{service}**",                      inline=True)
    ticket_embed.add_field(name="🏷️ Tier",   value=f"{TIER_EMOJI[t]} `{t.upper()}`",       inline=True)
    ticket_embed.add_field(name="🔑 Claim Code",    value=f"```{code}```",     inline=False)
    ticket_embed.add_field(name="📋 Staff Command", value=f"`/redeem {code}`", inline=False)
    ticket_embed.set_footer(text=f"Remaining stock: {len(stock)} accounts")
    ticket_embed.timestamp = discord.utils.utcnow()
    await ticket.send(f"<@&{STAFF_ROLE}> {interaction.user.mention}", embed=ticket_embed)

    confirm = embed_success(
        "Ticket Created!",
        f"Your ticket has been opened, {interaction.user.mention}!\nA staff member will assist you shortly."
    )
    confirm.add_field(name="🎫 Ticket",  value=ticket.mention,                   inline=True)
    confirm.add_field(name="📦 Service", value=f"**{service}** ({t.upper()})",    inline=True)
    await interaction.followup.send(embed=confirm)

    stats      = load_json(STATS_FILE)
    uid        = str(interaction.user.id)
    stats[uid] = stats.get(uid, 0) + 1
    save_json(STATS_FILE, stats)

    log = embed_log("📝 Generation", f"{interaction.user.mention} generated a **{service}** account ({t})")
    log.add_field(name="Ticket", value=ticket.mention)
    await send_log(interaction.guild, log)

# ------------------ /redeem ------------------
@tree.command(name="redeem", description="[Staff] Validate a generation ticket")
@app_commands.describe(code="The claim code from the ticket")
async def redeem(interaction: discord.Interaction, code: str):
    await interaction.response.defer()

    member = interaction.guild.get_member(interaction.user.id)
    if not (is_helper(member) or is_mod(member)):
        return await interaction.followup.send(embed=embed_error(
            "Access Denied", "You do not have permission to use this command."
        ))

    pending = load_json(PENDING_FILE)
    if code not in pending:
        return await interaction.followup.send(embed=embed_error(
            "Invalid Code", "This code does not exist or has already been used."
        ))

    account = pending[code]["account"]
    user_id = pending[code]["user"]
    user    = interaction.guild.get_member(user_id)

    if not user:
        return await interaction.followup.send(embed=embed_error(
            "Member Not Found", "The user is no longer in this server."
        ))

    dm_embed = discord.Embed(
        title="📦  Your Account is Ready!",
        description="Here are your generated credentials. Do not share them with anyone!",
        color=C_SUCCESS
    )
    dm_embed.add_field(name="🔐 Credentials", value=f"```{account}```", inline=False)
    dm_embed.set_footer(text="Gen Bot • Thank you for your trust!")
    dm_embed.timestamp = discord.utils.utcnow()

    try:
        await user.send(embed=dm_embed)
        await interaction.followup.send(embed=embed_success(
            "Account Sent!", f"Credentials have been sent via DM to {user.mention}."
        ))
    except discord.Forbidden:
        await interaction.followup.send(embed=embed_warn(
            "DMs Closed", f"Could not send a DM to {user.mention}."
        ))
    except Exception as ex:
        await interaction.followup.send(embed=embed_error("Error", str(ex)))

    del pending[code]
    save_json(PENDING_FILE, pending)

    # +1 vouch for the staff member
    new_vouches = add_vouch(interaction.user.id)
    await check_and_promote(interaction.guild, member, new_vouches)

    log = embed_log("📝 Redeem", f"{interaction.user.mention} validated a ticket for {user.mention}")
    log.add_field(name="Account",       value=f"||`{account}`||")
    log.add_field(name="Staff Vouches", value=f"**{new_vouches}**")
    await send_log(interaction.guild, log)

    await asyncio.sleep(5)
    if interaction.channel:
        await interaction.channel.delete(reason="Ticket redeemed")

# ------------------ /addv ------------------
@tree.command(name="addv", description="[Admin] Manually add vouches to a member")
@app_commands.describe(member="Target member", amount="Number of vouches to add")
async def addv(interaction: discord.Interaction, member: discord.Member, amount: int):
    await interaction.response.defer()

    invoker = interaction.guild.get_member(interaction.user.id)
    if not has_addv_role(invoker):
        return await interaction.followup.send(embed=embed_error(
            "Access Denied", "You do not have permission to use this command."
        ))

    if amount < 1:
        return await interaction.followup.send(embed=embed_error(
            "Invalid Amount", "Amount must be at least **1**."
        ))

    new_vouches = add_vouch(member.id, amount)
    await check_and_promote(interaction.guild, member, new_vouches)

    await interaction.followup.send(embed=embed_success(
        "Vouches Added!",
        f"Added **{amount}** vouch{'es' if amount > 1 else ''} to {member.mention}.\n"
        f"Their new total: **{new_vouches}** vouches."
    ))

    log = embed_log("📝 Vouches Added", f"{interaction.user.mention} manually added **{amount}** vouches to {member.mention}")
    log.add_field(name="New Total", value=f"**{new_vouches}**")
    await send_log(interaction.guild, log)

# ------------------ /promote ------------------
@tree.command(name="promote", description="View vouch progress toward the next promotion")
@app_commands.describe(member="Member to check (leave empty for yourself)")
async def promote(interaction: discord.Interaction, member: discord.Member = None):
    await interaction.response.defer()

    target  = member or interaction.user
    vouches = get_vouches(target.id)
    next_t  = next_vouch_tier(vouches)

    embed = discord.Embed(
        title="🏅  Vouch Progress",
        description=f"Promotion statistics for {target.mention}",
        color=C_INFO
    )
    embed.set_thumbnail(url=target.display_avatar.url)
    embed.add_field(name="⭐ Total Vouches", value=f"**{vouches}**", inline=True)

    if next_t:
        threshold, role_ids = next_t
        needed        = threshold - vouches
        filled        = round(min(vouches / threshold, 1.0) * 10)
        bar           = "█" * filled + "░" * (10 - filled)
        role_mentions = " · ".join(f"<@&{rid}>" for rid in role_ids)
        embed.add_field(name="🎯 Next Milestone", value=f"**{threshold} vouches** → {role_mentions}", inline=True)
        embed.add_field(name="📊 Progress", value=f"`{bar}` {vouches}/{threshold}  (**{needed}** remaining)", inline=False)
    else:
        embed.add_field(name="🏆 Status", value="Maximum rank reached — all tiers unlocked!", inline=False)

    tiers_lines = []
    for threshold, role_ids in VOUCH_TIERS:
        status       = "✅" if vouches >= threshold else "🔒"
        role_mention = " · ".join(f"<@&{rid}>" for rid in role_ids)
        tiers_lines.append(f"{status} **{threshold} vouches** → {role_mention}")
    embed.add_field(name="📋 All Milestones", value="\n".join(tiers_lines), inline=False)

    embed.set_footer(text="Vouches are earned by redeeming tickets • Never reset")
    embed.timestamp = discord.utils.utcnow()
    await interaction.response.send_message(embed=embed) if not interaction.response.is_done() else await interaction.followup.send(embed=embed)

# ------------------ /stock ------------------
async def _build_stock_embed(tier: str) -> discord.Embed:
    tiers     = ["free", "premium", "paid"] if tier == "all" else [tier]
    color_map = {"free": C_FREE, "premium": C_PREMIUM, "paid": C_PAID, "all": C_INFO}
    embed     = discord.Embed(title=f"📦  Stock — {tier.capitalize()}", color=color_map.get(tier, C_INFO))
    total     = 0

    for t in tiers:
        lines = []
        try:
            files = repo.get_contents(f"{ACCOUNTS_DIR}/{t}")
            if not isinstance(files, list):
                files = [files]
            for f in files:
                service = f.name.replace(".txt", "")
                count   = len(github_read(f.path))
                total  += count
                filled  = min(count // 10, 10)
                bar     = "█" * filled + "░" * (10 - filled)
                lines.append(f"`{bar}` **{service}** — {count} accounts")
        except GithubException:
            lines.append("*No stock available*")
        embed.add_field(name=f"{TIER_EMOJI[t]}  {t.upper()}", value="\n".join(lines) or "*Empty*", inline=False)

    embed.set_footer(text=f"Total: {total} accounts available")
    embed.timestamp = discord.utils.utcnow()
    return embed

@tree.command(name="stock", description="View available account stock")
@app_commands.describe(tier="Filter by tier (leave empty for all)")
@app_commands.choices(tier=TIER_CHOICES)
async def stock(interaction: discord.Interaction, tier: app_commands.Choice[str] = None):
    await interaction.response.defer()
    embed = await _build_stock_embed(tier.value if tier else "all")
    await interaction.followup.send(embed=embed)

# ------------------ /profile ------------------
@tree.command(name="profile", description="View a member's profile & stats")
@app_commands.describe(member="Member to view (leave empty for yourself)")
async def profile(interaction: discord.Interaction, member: discord.Member = None):
    await interaction.response.defer()

    target  = member or interaction.user
    stats   = load_json(STATS_FILE)
    count   = stats.get(str(target.id), 0)
    cd      = load_json(COOLDOWN_FILE).get(str(target.id), {"free": [], "premium": [], "paid": []})
    vouches = get_vouches(target.id)

    now          = int(time.time())
    free_uses    = len([t for t in cd["free"]    if now - t < 3600])
    premium_uses = len([t for t in cd["premium"] if now - t < 3600])
    paid_uses    = len([t for t in cd["paid"]    if now - t < 3600])

    def usage_bar(uses, max_uses):
        filled = round((uses / max_uses) * 5)
        return "🟩" * filled + "⬛" * (5 - filled) + f"  `{uses}/{max_uses}`"

    embed = discord.Embed(title="👤  Profile", description=f"Statistics for {target.mention}", color=C_INFO)
    embed.set_thumbnail(url=target.display_avatar.url)
    embed.add_field(name="🎯 Total Generations", value=f"**{count}**",   inline=True)
    embed.add_field(name="⭐ Total Vouches",      value=f"**{vouches}**", inline=True)
    embed.add_field(name="\u200b", value="\u200b", inline=True)
    embed.add_field(name="🟢 Free",    value=usage_bar(free_uses, 1),    inline=True)
    embed.add_field(name="🟣 Premium", value=usage_bar(premium_uses, 3), inline=True)
    embed.add_field(name="🟡 Paid",    value=usage_bar(paid_uses, 10),   inline=True)
    embed.set_footer(text="Quota resets every hour • Vouches never reset")
    embed.timestamp = discord.utils.utcnow()
    await interaction.followup.send(embed=embed)

# ------------------ /leaderboard ------------------
@tree.command(name="leaderboard", description="Top 10 account generators")
async def leaderboard(interaction: discord.Interaction):
    await interaction.response.defer()

    stats        = load_json(STATS_FILE)
    sorted_stats = sorted(stats.items(), key=lambda x: int(x[1]), reverse=True)[:10]
    medals       = {1: "🥇", 2: "🥈", 3: "🥉"}

    embed = discord.Embed(title="🏆  Leaderboard — Top Generators", color=C_PAID)
    if not sorted_stats:
        embed.description = "*No generations yet.*"
    else:
        lines = []
        for i, (uid, count) in enumerate(sorted_stats, 1):
            user   = interaction.guild.get_member(int(uid))
            name   = user.display_name if user else f"User #{uid}"
            medal  = medals.get(i, f"`#{i}`")
            plural = "s" if count > 1 else ""
            lines.append(f"{medal}  **{name}** — {count} generation{plural}")
        embed.description = "\n".join(lines)

    embed.set_footer(text=f"Requested by {interaction.user.display_name}")
    embed.timestamp = discord.utils.utcnow()
    await interaction.followup.send(embed=embed)

# ------------------ /add ------------------
@tree.command(name="add", description="[Staff] Add accounts from a .txt file")
@app_commands.describe(tier="Account tier", service="Service name", file="The .txt file with accounts")
@app_commands.choices(tier=TIER_CHOICES)
async def add(interaction: discord.Interaction, tier: app_commands.Choice[str], service: str, file: discord.Attachment):
    await interaction.response.defer()

    member = interaction.guild.get_member(interaction.user.id)
    if not (is_helper(member) or is_mod(member)):
        return await interaction.followup.send(embed=embed_error(
            "Access Denied", "You do not have permission to use this command."
        ))

    if not file.filename.endswith(".txt"):
        return await interaction.followup.send(embed=embed_error(
            "Invalid File", "Only `.txt` files are accepted."
        ))

    try:
        data  = await file.read()
        lines = [line.decode().strip() for line in data.splitlines() if line.strip()]
    except Exception as ex:
        return await interaction.followup.send(embed=embed_error("Read Error", str(ex)))

    t       = tier.value
    service = normalize(service)
    path    = f"{ACCOUNTS_DIR}/{t}/{service}.txt"
    stock   = github_read(path)
    stock.extend(lines)
    github_write(path, stock)

    await interaction.followup.send(embed=embed_success(
        "Stock Updated!",
        f"**{len(lines)}** accounts added to `{t}/{service}`.\nTotal stock: **{len(stock)}** accounts."
    ))

    log = embed_log("📝 Stock Added", f"{interaction.user.mention} added **{len(lines)}** accounts → `{t}/{service}`")
    await send_log(interaction.guild, log)

# ------------------ /remove ------------------
@tree.command(name="remove", description="[Mod] Remove accounts from stock")
@app_commands.describe(tier="Account tier", service="Service name", amount="Number of accounts to remove")
@app_commands.choices(tier=TIER_CHOICES)
async def remove(interaction: discord.Interaction, tier: app_commands.Choice[str], service: str, amount: int):
    await interaction.response.defer()

    member = interaction.guild.get_member(interaction.user.id)
    if not is_mod(member):
        return await interaction.followup.send(embed=embed_error(
            "Access Denied", "You do not have permission to use this command."
        ))

    if amount < 1:
        return await interaction.followup.send(embed=embed_error(
            "Invalid Amount", "Amount must be at least **1**."
        ))

    t       = tier.value
    service = normalize(service)
    path    = f"{ACCOUNTS_DIR}/{t}/{service}.txt"
    stock   = github_read(path)

    if len(stock) < amount:
        return await interaction.followup.send(embed=embed_warn(
            "Insufficient Stock", f"Only **{len(stock)}** accounts available for `{t}/{service}`."
        ))

    stock = stock[amount:]
    github_write(path, stock)

    await interaction.followup.send(embed=embed_success(
        "Stock Updated!",
        f"**{amount}** accounts removed from `{t}/{service}`.\nRemaining stock: **{len(stock)}** accounts."
    ))

    log = embed_log("📝 Stock Removed", f"{interaction.user.mention} removed **{amount}** accounts from `{t}/{service}`")
    await send_log(interaction.guild, log)

# ------------------ /send ------------------
@tree.command(name="send", description="[Staff] Send accounts via DM to a member")
@app_commands.describe(member="Target member", amount="Number of accounts", service="Service name")
async def send(interaction: discord.Interaction, member: discord.Member, amount: int, service: str):
    await interaction.response.defer()

    invoker = interaction.guild.get_member(interaction.user.id)
    if not (is_helper(invoker) or is_mod(invoker)):
        return await interaction.followup.send(embed=embed_error(
            "Access Denied", "You do not have permission to use this command."
        ))

    if amount < 1:
        return await interaction.followup.send(embed=embed_error(
            "Invalid Amount", "Amount must be at least **1**."
        ))

    if not is_mod(invoker):
        data     = load_json(SEND_COOLDOWN_FILE)
        now      = int(time.time())
        user_key = str(interaction.user.id)
        uses     = [t for t in data.get(user_key, []) if now - t < 3600]
        if len(uses) >= 5:
            return await interaction.followup.send(embed=embed_warn(
                "Limit Reached", "You can only send accounts **5 times** per hour."
            ))
        uses.append(now)
        data[user_key] = uses
        save_json(SEND_COOLDOWN_FILE, data)

    service    = normalize(service)
    sent       = False
    CHUNK_SIZE = 10  # keep DMs under Discord's 2000-char limit

    for tier in ["free", "premium", "paid"]:
        path  = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
        stock = github_read(path)
        if len(stock) >= amount:
            send_accounts = stock[:amount]
            stock         = stock[amount:]
            github_write(path, stock)
            try:
                for i in range(0, len(send_accounts), CHUNK_SIZE):
                    chunk    = send_accounts[i:i + CHUNK_SIZE]
                    dm_embed = discord.Embed(
                        title=f"📦  **{service}** Accounts ({tier.upper()})",
                        description="```\n" + "\n".join(chunk) + "\n```",
                        color=TIER_COLOR[tier]
                    )
                    dm_embed.set_footer(text=f"Sent by {interaction.user.display_name} • Gen Bot")
                    dm_embed.timestamp = discord.utils.utcnow()
                    await member.send(embed=dm_embed)

                await interaction.followup.send(embed=embed_success(
                    "Accounts Sent!",
                    f"**{amount}** **{service}** account(s) sent via DM to {member.mention}."
                ))
                sent = True
            except discord.Forbidden:
                await interaction.followup.send(embed=embed_warn(
                    "DMs Closed", f"Could not send a DM to {member.mention}."
                ))
            except Exception as ex:
                await interaction.followup.send(embed=embed_error("Error", str(ex)))
            break

    if not sent:
        await interaction.followup.send(embed=embed_error(
            "Insufficient Stock", f"Not enough **{service}** accounts in any tier."
        ))
    else:
        log = embed_log("📝 Direct Send", f"{interaction.user.mention} sent **{amount}** `{service}` to {member.mention}")
        await send_log(interaction.guild, log)

# ------------------ /help ------------------
@tree.command(name="help", description="List all available commands")
async def help(interaction: discord.Interaction):
    embed = discord.Embed(
        title="📜  Commands — Gen Bot",
        description="All commands use `/`",
        color=C_INFO
    )
    embed.add_field(
        name="👥  Members",
        value=(
            "`/gen` — Generate an account\n"
            "`/profile` — View profile & stats\n"
            "`/promote` — View vouch progress toward next rank\n"
            "`/leaderboard` — Top 10 generators\n"
            "`/stock` — View available stock"
        ),
        inline=False
    )
    embed.add_field(
        name="🛡️  Staff",
        value=(
            "`/redeem` — Validate a ticket\n"
            "`/add` — Add accounts (attach `.txt`)\n"
            "`/send` — Send accounts via DM\n"
            "`/remove` — Remove stock\n"
            "`/addv` — Manually add vouches to a member"
        ),
        inline=False
    )
    embed.add_field(
        name="🏷️  Available Tiers",
        value="🟢 `free` · 🟣 `premium` · 🟡 `paid`",
        inline=False
    )
    embed.set_footer(text="Gen Bot • Need help? Contact a staff member.")
    embed.timestamp = discord.utils.utcnow()
    await interaction.response.send_message(embed=embed)

# ------------------ ERROR HANDLER ------------------
@tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    msg = str(error)
    try:
        await interaction.response.send_message(embed=embed_error("An Error Occurred", msg))
    except discord.InteractionResponded:
        await interaction.followup.send(embed=embed_error("An Error Occurred", msg))
    raise error

if __name__ == "__main__" or __name__ == "bot":
    bot.run(TOKEN)
