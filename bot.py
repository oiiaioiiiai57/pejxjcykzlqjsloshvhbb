import discord
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

STAFF_ROLE  = 1479080681983316004
HELPER_ROLE = 1479080681983316008
MODERATOR_ROLES = [
    1479080681983316006,
    1479080681983316007,
    1479080681996030042,
    1479080681996030043
]

# Vouch promotion tiers  (threshold -> list of role IDs to grant)
# 40 vouches : grant role 1479080681983316005 + Helper (1479080681983316008)
# 60 vouches : grant role 1479080681983316006
# 100 vouches: grant role 1479080681983316007
VOUCH_TIERS = [
    (40,  [1479080681983316005, 1479080681983316008]),
    (60,  [1479080681983316006]),
    (100, [1479080681983316007]),
]

# ------------------ COLORS ------------------
C_SUCCESS = 0x57F287   # green
C_ERROR   = 0xED4245   # red
C_WARN    = 0xFEE75C   # yellow
C_INFO    = 0x5865F2   # blurple
C_LOG     = 0x2B2D31   # dark grey
C_FREE    = 0x57F287   # green  — free tier
C_PREMIUM = 0xA855F7   # purple — premium tier
C_PAID    = 0xFFD166   # gold   — paid tier

TIER_COLOR = {"free": C_FREE, "premium": C_PREMIUM, "paid": C_PAID}
TIER_EMOJI = {"free": "🟢", "premium": "🟣", "paid": "🟡"}

# ------------------ INIT ------------------
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents, case_insensitive=True)
bot.remove_command("help")

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

def embed_info(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=f"ℹ️  {title}", description=description, color=C_INFO)
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

    limits = {"free": (1, 3600), "premium": (3, 3600), "paid": (10, 3600)}
    if tier not in limits:
        raise ValueError(f"Invalid tier: {tier}")

    max_use, period = limits[tier]
    now  = int(time.time())
    uses = [t for t in data[user_key][tier] if now - t < period]

    if len(uses) >= max_use:
        remaining = period - (now - uses[0])
        return False, remaining

    uses.append(now)
    data[user_key][tier] = uses
    save_json(COOLDOWN_FILE, data)
    return True, 0

# ------------------ VOUCH HELPERS ------------------
def get_vouches(user_id: int) -> int:
    data = load_json(VOUCHES_FILE)
    return data.get(str(user_id), 0)

def add_vouch(user_id: int) -> int:
    """Increment vouch count and return new total. Vouches never reset."""
    data     = load_json(VOUCHES_FILE)
    key      = str(user_id)
    data[key] = data.get(key, 0) + 1
    save_json(VOUCHES_FILE, data)
    return data[key]

def next_vouch_tier(current: int) -> tuple[int, list[int]] | None:
    """Return (threshold, role_ids) of the next unreached tier, or None if maxed."""
    for threshold, role_ids in VOUCH_TIERS:
        if current < threshold:
            return threshold, role_ids
    return None

async def check_and_promote(guild: discord.Guild, member: discord.Member, vouches: int):
    """Grant roles when a vouch milestone is exactly crossed."""
    for threshold, role_ids in VOUCH_TIERS:
        if vouches == threshold:
            for role_id in role_ids:
                role = guild.get_role(role_id)
                if role and role not in member.roles:
                    await member.add_roles(role, reason=f"Reached {threshold} vouches")
            role_mentions = " ".join(
                f"<@&{rid}>" for rid in role_ids if guild.get_role(rid)
            )
            log       = embed_log("🎉  Promotion", f"{member.mention} has been promoted to {role_mentions} with **{vouches} vouches**!")
            log.color = C_PREMIUM
            await send_log(guild, log)

# ------------------ READY ------------------
@bot.event
async def on_ready():
    print(f"Bot online: {bot.user}")
    await bot.change_presence(activity=discord.Game("!help • Gen Bot"))

# ------------------ GEN ------------------
@bot.command()
async def gen(ctx: commands.Context, tier: str = None, service: str = None):
    if tier is None or service is None:
        return await ctx.send(embed=embed_error(
            "Invalid Usage", "**Syntax:** `!gen <free|premium|paid> <service>`"
        ))

    tier = tier.lower()
    if tier not in ["free", "premium", "paid"]:
        return await ctx.send(embed=embed_error(
            "Invalid Tier", "Choose from: `free` · `premium` · `paid`"
        ))

    channels = {"free": FREE_CHANNEL, "premium": PREMIUM_CHANNEL, "paid": PAID_CHANNEL}
    if ctx.channel.id != channels[tier]:
        return

    if not is_mod(ctx.author):
        allowed, remaining = check_cooldown(ctx.author.id, tier)
        if not allowed:
            minutes, seconds = divmod(remaining, 60)
            return await ctx.send(embed=embed_warn(
                "Cooldown Active",
                f"Please wait **{minutes}m {seconds}s** before generating again."
            ), delete_after=30)

    service = normalize(service)
    path    = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock   = github_read(path)

    if not stock:
        return await ctx.send(embed=embed_error(
            "Out of Stock",
            f"No **{service}** accounts available in the **{tier}** tier."
        ))

    account = stock.pop(0)
    github_write(path, stock)

    code    = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    pending = load_json(PENDING_FILE)
    pending[code] = {"account": account, "user": ctx.author.id}
    save_json(PENDING_FILE, pending)

    category = bot.get_channel(TICKET_CATEGORY)
    if not category or not isinstance(category, discord.CategoryChannel):
        return await ctx.send(embed=embed_error(
            "Category Not Found", "The ticket category could not be found."
        ))

    overwrites = {
        ctx.guild.default_role: discord.PermissionOverwrite(read_messages=False),
        ctx.author:             discord.PermissionOverwrite(read_messages=True, send_messages=True),
        ctx.guild.me:           discord.PermissionOverwrite(read_messages=True, send_messages=True),
    }
    ticket_name = f"{service.lower()}-{ctx.author.name.lower()}-{random.randint(1000, 9999)}"
    ticket      = await category.create_text_channel(name=ticket_name, overwrites=overwrites)

    ticket_embed = discord.Embed(
        title="🎟️  Generation Ticket",
        description="Your account has been reserved! A staff member will validate your ticket shortly.",
        color=TIER_COLOR[tier]
    )
    ticket_embed.add_field(name="👤 Member",  value=ctx.author.mention,                        inline=True)
    ticket_embed.add_field(name="📦 Service", value=f"**{service}**",                          inline=True)
    ticket_embed.add_field(name="🏷️ Tier",   value=f"{TIER_EMOJI[tier]} `{tier.upper()}`",     inline=True)
    ticket_embed.add_field(name="🔑 Claim Code",    value=f"```{code}```",       inline=False)
    ticket_embed.add_field(name="📋 Staff Command", value=f"`!redeem {code}`",   inline=False)
    ticket_embed.set_footer(text=f"Remaining stock: {len(stock)} accounts")
    ticket_embed.timestamp = discord.utils.utcnow()
    await ticket.send(f"<@&{STAFF_ROLE}> {ctx.author.mention}", embed=ticket_embed)

    confirm = embed_success(
        "Ticket Created!",
        f"Your ticket has been opened, {ctx.author.mention}!\nA staff member will assist you shortly."
    )
    confirm.add_field(name="🎫 Ticket",  value=ticket.mention,                    inline=True)
    confirm.add_field(name="📦 Service", value=f"**{service}** ({tier.upper()})",  inline=True)
    await ctx.send(embed=confirm)

    stats      = load_json(STATS_FILE)
    uid        = str(ctx.author.id)
    stats[uid] = stats.get(uid, 0) + 1
    save_json(STATS_FILE, stats)

    log = embed_log("📝 Generation", f"{ctx.author.mention} generated a **{service}** account ({tier})")
    log.add_field(name="Ticket", value=ticket.mention)
    await send_log(ctx.guild, log)

# ------------------ REDEEM ------------------
@bot.command()
async def redeem(ctx: commands.Context, code: str = None):
    if not (is_helper(ctx.author) or is_mod(ctx.author)):
        return

    if code is None:
        return await ctx.send(embed=embed_error(
            "Invalid Usage", "**Syntax:** `!redeem <code>`"
        ))

    pending = load_json(PENDING_FILE)
    if code not in pending:
        return await ctx.send(embed=embed_error(
            "Invalid Code", "This code does not exist or has already been used."
        ))

    account = pending[code]["account"]
    user_id = pending[code]["user"]
    user    = ctx.guild.get_member(user_id)

    if not user:
        return await ctx.send(embed=embed_error(
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
        await ctx.send(embed=embed_success(
            "Account Sent!", f"Credentials have been sent via DM to {user.mention}."
        ))
    except discord.Forbidden:
        await ctx.send(embed=embed_warn(
            "DMs Closed", f"Could not send a DM to {user.mention}."
        ))
    except Exception as ex:
        await ctx.send(embed=embed_error("Error", str(ex)))

    del pending[code]
    save_json(PENDING_FILE, pending)

    # +1 vouch for the staff member who redeemed
    new_vouches = add_vouch(ctx.author.id)
    await check_and_promote(ctx.guild, ctx.author, new_vouches)

    log = embed_log("📝 Redeem", f"{ctx.author.mention} validated a ticket for {user.mention}")
    log.add_field(name="Account",       value=f"||`{account}`||")
    log.add_field(name="Staff Vouches", value=f"**{new_vouches}**")
    await send_log(ctx.guild, log)

    await asyncio.sleep(5)
    await ctx.channel.delete(reason="Ticket redeemed")

# ------------------ PROMOTE ------------------
@bot.command()
async def promote(ctx: commands.Context, member: discord.Member = None):
    """Show vouch progress toward the next promotion tier."""
    target  = member or ctx.author
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
        needed              = threshold - vouches
        progress            = min(vouches / threshold, 1.0)
        filled              = round(progress * 10)
        bar                 = "█" * filled + "░" * (10 - filled)
        role_mentions       = " · ".join(f"<@&{rid}>" for rid in role_ids)

        embed.add_field(name="🎯 Next Milestone", value=f"**{threshold} vouches** → {role_mentions}", inline=True)
        embed.add_field(
            name="📊 Progress",
            value=f"`{bar}` {vouches}/{threshold}  (**{needed}** remaining)",
            inline=False
        )
    else:
        embed.add_field(name="🏆 Status", value="Maximum rank reached — all tiers unlocked!", inline=False)

    # All tiers overview
    tiers_lines = []
    for threshold, role_ids in VOUCH_TIERS:
        status       = "✅" if vouches >= threshold else "🔒"
        role_mention = " · ".join(f"<@&{rid}>" for rid in role_ids)
        tiers_lines.append(f"{status} **{threshold} vouches** → {role_mention}")
    embed.add_field(name="📋 All Milestones", value="\n".join(tiers_lines), inline=False)

    embed.set_footer(text="Vouches are earned by redeeming tickets • Vouches never reset")
    embed.timestamp = discord.utils.utcnow()
    await ctx.send(embed=embed)

# ------------------ STOCK ------------------
async def send_stock(ctx: commands.Context, tier: str):
    tiers     = ["free", "premium", "paid"] if tier == "all" else [tier]
    color_map = {"free": C_FREE, "premium": C_PREMIUM, "paid": C_PAID, "all": C_INFO}

    embed = discord.Embed(
        title=f"📦  Stock — {tier.capitalize()}",
        color=color_map.get(tier, C_INFO)
    )

    total = 0
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

        embed.add_field(
            name=f"{TIER_EMOJI[t]}  {t.upper()}",
            value="\n".join(lines) if lines else "*Empty*",
            inline=False
        )

    embed.set_footer(text=f"Total: {total} accounts available")
    embed.timestamp = discord.utils.utcnow()
    await ctx.send(embed=embed)

@bot.command()
async def stock(ctx): await send_stock(ctx, "all")

@bot.command(name="stock-free")
async def stock_free(ctx): await send_stock(ctx, "free")

@bot.command(name="stock-premium")
async def stock_premium(ctx): await send_stock(ctx, "premium")

@bot.command(name="stock-paid")
async def stock_paid(ctx): await send_stock(ctx, "paid")

# ------------------ PROFILE ------------------
@bot.command()
async def profile(ctx: commands.Context, member: discord.Member = None):
    member  = member or ctx.author
    stats   = load_json(STATS_FILE)
    count   = stats.get(str(member.id), 0)
    cd      = load_json(COOLDOWN_FILE).get(str(member.id), {"free": [], "premium": [], "paid": []})
    vouches = get_vouches(member.id)

    now          = int(time.time())
    free_uses    = len([t for t in cd["free"]    if now - t < 3600])
    premium_uses = len([t for t in cd["premium"] if now - t < 3600])
    paid_uses    = len([t for t in cd["paid"]    if now - t < 3600])

    def usage_bar(uses, max_uses):
        filled = round((uses / max_uses) * 5)
        return "🟩" * filled + "⬛" * (5 - filled) + f"  `{uses}/{max_uses}`"

    embed = discord.Embed(
        title="👤  Profile",
        description=f"Statistics for {member.mention}",
        color=C_INFO
    )
    embed.set_thumbnail(url=member.display_avatar.url)
    embed.add_field(name="🎯 Total Generations", value=f"**{count}**",   inline=True)
    embed.add_field(name="⭐ Total Vouches",      value=f"**{vouches}**", inline=True)
    embed.add_field(name="\u200b", value="\u200b", inline=True)
    embed.add_field(name="🟢 Free",    value=usage_bar(free_uses, 1),    inline=True)
    embed.add_field(name="🟣 Premium", value=usage_bar(premium_uses, 3), inline=True)
    embed.add_field(name="🟡 Paid",    value=usage_bar(paid_uses, 10),   inline=True)
    embed.set_footer(text="Quota resets every hour • Vouches never reset")
    embed.timestamp = discord.utils.utcnow()
    await ctx.send(embed=embed)

# ------------------ LEADERBOARD ------------------
@bot.command()
async def leaderboard(ctx: commands.Context):
    stats        = load_json(STATS_FILE)
    sorted_stats = sorted(stats.items(), key=lambda x: int(x[1]), reverse=True)[:10]
    medals       = {1: "🥇", 2: "🥈", 3: "🥉"}

    embed = discord.Embed(title="🏆  Leaderboard — Top Generators", color=C_PAID)

    if not sorted_stats:
        embed.description = "*No generations yet.*"
    else:
        lines = []
        for i, (uid, count) in enumerate(sorted_stats, 1):
            user   = ctx.guild.get_member(int(uid))
            name   = user.display_name if user else f"User #{uid}"
            medal  = medals.get(i, f"`#{i}`")
            plural = "s" if count > 1 else ""
            lines.append(f"{medal}  **{name}** — {count} generation{plural}")
        embed.description = "\n".join(lines)

    embed.set_footer(text=f"Requested by {ctx.author.display_name}")
    embed.timestamp = discord.utils.utcnow()
    await ctx.send(embed=embed)

# ------------------ ADD ------------------
@bot.command()
async def add(ctx: commands.Context, tier: str = None, service: str = None):
    if not (is_helper(ctx.author) or is_mod(ctx.author)):
        return

    if tier is None or service is None:
        return await ctx.send(embed=embed_error(
            "Invalid Usage", "**Syntax:** `!add <free|premium|paid> <service>` + `.txt` attachment"
        ))

    tier = tier.lower()
    if tier not in ["free", "premium", "paid"]:
        return await ctx.send(embed=embed_error(
            "Invalid Tier", "Choose from: `free` · `premium` · `paid`"
        ))

    if not ctx.message.attachments:
        return await ctx.send(embed=embed_error(
            "No Attachment", "Please attach a `.txt` file containing the accounts."
        ))

    attachment = ctx.message.attachments[0]
    if not attachment.filename.endswith(".txt"):
        return await ctx.send(embed=embed_error(
            "Invalid File", "Only `.txt` files are accepted."
        ))

    try:
        data  = await attachment.read()
        lines = [line.decode().strip() for line in data.splitlines() if line.strip()]
    except Exception as ex:
        return await ctx.send(embed=embed_error("Read Error", str(ex)))

    service = normalize(service)
    path    = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock   = github_read(path)
    stock.extend(lines)
    github_write(path, stock)

    await ctx.send(embed=embed_success(
        "Stock Updated!",
        f"**{len(lines)}** accounts added to `{tier}/{service}`.\nTotal stock: **{len(stock)}** accounts."
    ))
    log = embed_log("📝 Stock Added", f"{ctx.author.mention} added **{len(lines)}** accounts → `{tier}/{service}`")
    await send_log(ctx.guild, log)

# ------------------ REMOVE ------------------
@bot.command()
async def remove(ctx: commands.Context, tier: str = None, service: str = None, amount: int = 1):
    if not is_mod(ctx.author):
        return

    if tier is None or service is None or amount < 1:
        return await ctx.send(embed=embed_error(
            "Invalid Usage", "**Syntax:** `!remove <free|premium|paid> <service> <amount>`"
        ))

    tier = tier.lower()
    if tier not in ["free", "premium", "paid"]:
        return await ctx.send(embed=embed_error(
            "Invalid Tier", "Choose from: `free` · `premium` · `paid`"
        ))

    service = normalize(service)
    path    = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock   = github_read(path)

    if len(stock) < amount:
        return await ctx.send(embed=embed_warn(
            "Insufficient Stock",
            f"Only **{len(stock)}** accounts available for `{tier}/{service}`."
        ))

    stock = stock[amount:]
    github_write(path, stock)

    await ctx.send(embed=embed_success(
        "Stock Updated!",
        f"**{amount}** accounts removed from `{tier}/{service}`.\nRemaining stock: **{len(stock)}** accounts."
    ))
    log = embed_log("📝 Stock Removed", f"{ctx.author.mention} removed **{amount}** accounts from `{tier}/{service}`")
    await send_log(ctx.guild, log)

# ------------------ SEND ------------------
@bot.command()
async def send(ctx: commands.Context, member: discord.Member = None, amount: int = 1, service: str = None):
    if not (is_helper(ctx.author) or is_mod(ctx.author)):
        return

    if member is None or service is None or amount < 1:
        return await ctx.send(embed=embed_error(
            "Invalid Usage", "**Syntax:** `!send <@member> <amount> <service>`"
        ))

    if not is_mod(ctx.author):
        data     = load_json(SEND_COOLDOWN_FILE)
        now      = int(time.time())
        user_key = str(ctx.author.id)
        uses     = [t for t in data.get(user_key, []) if now - t < 3600]
        if len(uses) >= 5:
            return await ctx.send(embed=embed_warn(
                "Limit Reached", "You can only send accounts **5 times** per hour."
            ))
        uses.append(now)
        data[user_key] = uses
        save_json(SEND_COOLDOWN_FILE, data)

    service    = normalize(service)
    sent       = False
    CHUNK_SIZE = 10  # max accounts per DM to stay under Discord's 2000-char limit

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
                    dm_embed.set_footer(text=f"Sent by {ctx.author.display_name} • Gen Bot")
                    dm_embed.timestamp = discord.utils.utcnow()
                    await member.send(embed=dm_embed)

                await ctx.send(embed=embed_success(
                    "Accounts Sent!",
                    f"**{amount}** **{service}** account(s) sent via DM to {member.mention}."
                ))
                sent = True
            except discord.Forbidden:
                await ctx.send(embed=embed_warn(
                    "DMs Closed", f"Could not send a DM to {member.mention}."
                ))
            except Exception as ex:
                await ctx.send(embed=embed_error("Error", str(ex)))
            break

    if not sent:
        await ctx.send(embed=embed_error(
            "Insufficient Stock", f"Not enough **{service}** accounts in any tier."
        ))
    else:
        log = embed_log("📝 Direct Send", f"{ctx.author.mention} sent **{amount}** `{service}` to {member.mention}")
        await send_log(ctx.guild, log)

# ------------------ HELP ------------------
@bot.command()
async def help(ctx: commands.Context):
    embed = discord.Embed(
        title="📜  Commands — Gen Bot",
        description="Prefix: `!`",
        color=C_INFO
    )
    embed.add_field(
        name="👥  Members",
        value=(
            "`!gen <tier> <service>` — Generate an account\n"
            "`!profile [@user]` — View profile & vouch stats\n"
            "`!promote [@user]` — View vouch progress toward next rank\n"
            "`!leaderboard` — Top 10 generators\n"
            "`!stock` — View all stock\n"
            "`!stock-free` · `!stock-premium` · `!stock-paid` — Stock by tier"
        ),
        inline=False
    )
    embed.add_field(
        name="🛡️  Staff",
        value=(
            "`!redeem <code>` — Validate a ticket *(earns +1 vouch)*\n"
            "`!add <tier> <service>` — Add accounts (attach `.txt`)\n"
            "`!send <@user> <amount> <service>` — Send accounts via DM\n"
            "`!remove <tier> <service> <amount>` — Remove stock"
        ),
        inline=False
    )
    embed.add_field(
        name="🏅  Vouch Milestones",
        value=(
            "🔒 **40 vouches** → <@&1479080681983316005> + <@&1479080681983316008>\n"
            "🔒 **60 vouches** → <@&1479080681983316006>\n"
            "🔒 **100 vouches** → <@&1479080681983316007>"
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
    await ctx.send(embed=embed)

# ------------------ ERROR HANDLER ------------------
@bot.event
async def on_command_error(ctx: commands.Context, error: commands.CommandError):
    if isinstance(error, commands.CommandNotFound):
        return
    await ctx.send(embed=embed_error("An Error Occurred", str(error)))
    raise error

bot.run(TOKEN)
