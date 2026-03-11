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
TOKEN = os.getenv("TOKEN")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME = "chevalier577pro/gen-bot"

# Channels & categories
FREE_CHANNEL = 1479204587104895060
PREMIUM_CHANNEL = 1479080682616520718
PAID_CHANNEL = 1479080682616520717
TICKET_CATEGORY = 1479080682784555134
LOG_CHANNEL = 1479239531499880628

# Roles
STAFF_ROLE = 1479080681983316004
HELPER_ROLE = 1479080681983316008
MODERATOR_ROLES = [
    1479080681983316006,
    1479080681983316007,
    1479080681996030042,
    1479080681996030043
]

# ------------------ INIT ------------------
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents, case_insensitive=True)
bot.remove_command("help")  # Remove default help command to avoid conflict

github = Github(auth=Auth.Token(GITHUB_TOKEN))
repo = github.get_repo(REPO_NAME)

ACCOUNTS_DIR = "accounts"
PENDING_FILE = "pending.json"
STATS_FILE = "stats.json"
COOLDOWN_FILE = "cooldowns.json"
SEND_COOLDOWN_FILE = "send_cooldown.json"

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
    content = "\n".join(data) + "\n"  # Add trailing newline for consistency
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

async def send_log(guild: discord.Guild, embed: discord.Embed):
    channel = guild.get_channel(LOG_CHANNEL)
    if channel:
        await channel.send(embed=embed)

# ------------------ COOLDOWNS ------------------
def check_cooldown(user_id: int, tier: str) -> tuple[bool, int]:
    data = load_json(COOLDOWN_FILE)
    user_key = str(user_id)
    if user_key not in data:
        data[user_key] = {"free": [], "premium": [], "paid": []}

    limits = {
        "free": (1, 3600),
        "premium": (3, 3600),
        "paid": (10, 3600)
    }
    if tier not in limits:
        raise ValueError(f"Invalid tier: {tier}")

    max_use, period = limits[tier]
    now = int(time.time())
    uses = [t for t in data[user_key][tier] if now - t < period]

    if len(uses) >= max_use:
        remaining = period - (now - uses[0])
        return False, remaining

    # Append now and save only if allowed
    uses.append(now)
    data[user_key][tier] = uses
    save_json(COOLDOWN_FILE, data)
    return True, 0

# ------------------ READY ------------------
@bot.event
async def on_ready():
    print(f"Bot connected: {bot.user}")
    await bot.change_presence(activity=discord.Game("Playing with code 😎"))

# ------------------ GEN ------------------
@bot.command()
async def gen(ctx: commands.Context, tier: str = None, service: str = None):
    if tier is None or service is None:
        embed = discord.Embed(title="❌ Usage", description="!gen <free|premium|paid> <service>", color=0xED4245)
        return await ctx.send(embed=embed)

    tier = tier.lower()
    if tier not in ["free", "premium", "paid"]:
        embed = discord.Embed(title="❌ Invalid Tier", description="Choose free, premium, or paid.", color=0xED4245)
        return await ctx.send(embed=embed)

    channels = {"free": FREE_CHANNEL, "premium": PREMIUM_CHANNEL, "paid": PAID_CHANNEL}
    if ctx.channel.id != channels[tier]:
        return  # Silent ignore if wrong channel

    if not is_mod(ctx.author):
        allowed, remaining = check_cooldown(ctx.author.id, tier)
        if not allowed:
            minutes = remaining // 60
            seconds = remaining % 60
            embed = discord.Embed(
                title="⏳ Cooldown",
                description=f"Wait **{minutes}m {seconds}s** before generating again.",
                color=0xE67E22
            )
            return await ctx.send(embed=embed, delete_after=30)

    service = normalize(service)
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)
    if not stock:
        embed = discord.Embed(title="❌ Out of Stock", description=f"No accounts available for {service} in {tier}.", color=0xED4245)
        return await ctx.send(embed=embed)

    account = stock.pop(0)
    github_write(path, stock)

    code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    pending = load_json(PENDING_FILE)
    pending[code] = {"account": account, "user": ctx.author.id}
    save_json(PENDING_FILE, pending)

    category = bot.get_channel(TICKET_CATEGORY)
    if not category or not isinstance(category, discord.CategoryChannel):
        embed = discord.Embed(title="❌ Error", description="Ticket category not found.", color=0xED4245)
        return await ctx.send(embed=embed)

    overwrites = {
        ctx.guild.default_role: discord.PermissionOverwrite(read_messages=False),
        ctx.author: discord.PermissionOverwrite(read_messages=True, send_messages=True),
        ctx.guild.me: discord.PermissionOverwrite(read_messages=True, send_messages=True)
    }

    ticket_name = f"{service.lower()}-{ctx.author.name.lower()}-{random.randint(1000, 9999)}"  # Unique name
    ticket = await category.create_text_channel(name=ticket_name, overwrites=overwrites)

    ticket_embed = discord.Embed(
        title="🎟 Generation Ticket",
        description=f"Service: **{service}**\nTier: **{tier.upper()}**",
        color=0x5865F2
    )
    ticket_embed.add_field(name="Redeem", value=f"`!redeem {code}`", inline=False)
    await ticket.send(f"<@&{STAFF_ROLE}> {ctx.author.mention}", embed=ticket_embed)

    confirm = discord.Embed(
        title="✅ Ticket Created",
        description=f"{ctx.author.mention}, your ticket has been created!",
        color=0x57F287
    )
    confirm.add_field(name="Ticket", value=ticket.mention)
    await ctx.send(embed=confirm)

    stats = load_json(STATS_FILE)
    uid = str(ctx.author.id)
    stats[uid] = stats.get(uid, 0) + 1
    save_json(STATS_FILE, stats)

    log_embed = discord.Embed(title="📝 Log: Generation", description=f"{ctx.author} generated {service} ({tier})", color=0x3498DB)
    await send_log(ctx.guild, log_embed)

# ------------------ REDEEM ------------------
@bot.command()
async def redeem(ctx: commands.Context, code: str = None):
    if not (is_helper(ctx.author) or is_mod(ctx.author)):
        return  # Silent ignore

    if code is None:
        embed = discord.Embed(title="❌ Usage", description="!redeem <code>", color=0xED4245)
        return await ctx.send(embed=embed)

    pending = load_json(PENDING_FILE)
    if code not in pending:
        embed = discord.Embed(title="❌ Invalid Code", description="The code does not exist or has been used.", color=0xED4245)
        return await ctx.send(embed=embed)

    account = pending[code]["account"]
    user_id = pending[code]["user"]
    user = ctx.guild.get_member(user_id)
    if not user:
        embed = discord.Embed(title="❌ Error", description="User not found in guild.", color=0xED4245)
        return await ctx.send(embed=embed)

    embed = discord.Embed(title="📦 Your Account", description=f"```{account}```", color=0x57F287)
    try:
        await user.send(embed=embed)
        await ctx.send(f"✅ Account sent to {user.mention}")
    except discord.Forbidden:
        await ctx.send(f"❌ Cannot send DM to {user.mention} (DMs closed)")
    except Exception as e:
        await ctx.send(f"❌ Error sending DM: {str(e)}")

    del pending[code]
    save_json(PENDING_FILE, pending)

    log_embed = discord.Embed(title="📝 Log: Redeem", description=f"{ctx.author} redeemed for {user} ({account})", color=0x3498DB)
    await send_log(ctx.guild, log_embed)

    await asyncio.sleep(5)
    await ctx.channel.delete(reason="Ticket redeemed")

# ------------------ STOCK ------------------
async def send_stock(ctx: commands.Context, tier: str):
    msg = ""
    if tier == "all":
        tiers = ["free", "premium", "paid"]
    else:
        tiers = [tier]

    for t in tiers:
        try:
            files = repo.get_contents(f"{ACCOUNTS_DIR}/{t}")
            if not isinstance(files, list):
                files = [files]
            for f in files:
                service = f.name.replace(".txt", "")
                stock = len(github_read(f.path))
                msg += f"**{t.upper()} | {service}** : {stock}\n"
        except GithubException:
            msg += f"No stock for {t}\n"

    color_map = {"free": 0x57F287, "premium": 0x9B59B6, "paid": 0xF1C40F, "all": 0xFEE75C}
    embed = discord.Embed(title=f"📦 {tier.capitalize()} Stock", description=msg or "No stock available.", color=color_map[tier])
    await ctx.send(embed=embed)

@bot.command()
async def stock(ctx: commands.Context):
    await send_stock(ctx, "all")

@bot.command(name="stock-free")
async def stock_free(ctx: commands.Context):
    await send_stock(ctx, "free")

@bot.command(name="stock-premium")
async def stock_premium(ctx: commands.Context):
    await send_stock(ctx, "premium")

@bot.command(name="stock-paid")
async def stock_paid(ctx: commands.Context):
    await send_stock(ctx, "paid")

# ------------------ PROFILE ------------------
@bot.command()
async def profile(ctx: commands.Context, member: discord.Member = None):
    member = member or ctx.author
    stats = load_json(STATS_FILE)
    count = stats.get(str(member.id), 0)
    cooldowns = load_json(COOLDOWN_FILE)
    cd = cooldowns.get(str(member.id), {"free": [], "premium": [], "paid": []})

    now = int(time.time())
    free_uses = len([t for t in cd["free"] if now - t < 3600])
    premium_uses = len([t for t in cd["premium"] if now - t < 3600])
    paid_uses = len([t for t in cd["paid"] if now - t < 3600])

    embed = discord.Embed(title="👤 Profile", color=0x3498DB)
    embed.add_field(name="User", value=member.mention)
    embed.add_field(name="Generations", value=count)
    embed.add_field(name="Free", value=f"{free_uses}/1")
    embed.add_field(name="Premium", value=f"{premium_uses}/3")
    embed.add_field(name="Paid", value=f"{paid_uses}/10")
    embed.set_thumbnail(url=member.display_avatar.url)
    await ctx.send(embed=embed)

# ------------------ LEADERBOARD ------------------
@bot.command()
async def leaderboard(ctx: commands.Context):
    stats = load_json(STATS_FILE)
    sorted_stats = sorted(stats.items(), key=lambda x: int(x[1]), reverse=True)[:10]
    embed = discord.Embed(title="🏆 Leaderboard", color=0xF1C40F)
    for i, (uid, count) in enumerate(sorted_stats, 1):
        user = ctx.guild.get_member(int(uid))
        name = user.display_name if user else f"User {uid}"
        embed.add_field(name=f"{i}. {name}", value=f"{count} gens", inline=False)
    if not sorted_stats:
        embed.description = "No generations yet."
    await ctx.send(embed=embed)

# ------------------ ADD ------------------
@bot.command()
async def add(ctx: commands.Context, tier: str = None, service: str = None):
    if not (is_helper(ctx.author) or is_mod(ctx.author)):
        return  # Silent ignore

    if tier is None or service is None:
        embed = discord.Embed(title="❌ Usage", description="!add <free|premium|paid> <service>", color=0xED4245)
        return await ctx.send(embed=embed)

    tier = tier.lower()
    if tier not in ["free", "premium", "paid"]:
        embed = discord.Embed(title="❌ Invalid Tier", description="Choose free, premium, or paid.", color=0xED4245)
        return await ctx.send(embed=embed)

    if not ctx.message.attachments:
        embed = discord.Embed(title="❌ No Attachment", description="Please attach a text file with accounts.", color=0xED4245)
        return await ctx.send(embed=embed)

    attachment = ctx.message.attachments[0]
    if not attachment.filename.endswith(".txt"):
        embed = discord.Embed(title="❌ Invalid File", description="Only .txt files are accepted.", color=0xED4245)
        return await ctx.send(embed=embed)

    try:
        data = await attachment.read()
        lines = [line.decode().strip() for line in data.splitlines() if line.strip()]
    except Exception as e:
        embed = discord.Embed(title="❌ Error Reading File", description=str(e), color=0xED4245)
        return await ctx.send(embed=embed)

    service = normalize(service)
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)
    stock.extend(lines)
    github_write(path, stock)
    await ctx.send(f"✅ Added {len(lines)} accounts to {tier}/{service}")

    log_embed = discord.Embed(title="📝 Log: Add Stock", description=f"{ctx.author} added {len(lines)} to {tier}/{service}", color=0x3498DB)
    await send_log(ctx.guild, log_embed)

# ------------------ REMOVE ------------------
@bot.command()
async def remove(ctx: commands.Context, tier: str = None, service: str = None, amount: int = 1):
    if not is_mod(ctx.author):
        return  # Silent ignore

    if tier is None or service is None or amount < 1:
        embed = discord.Embed(title="❌ Usage", description="!remove <free|premium|paid> <service> <amount>", color=0xED4245)
        return await ctx.send(embed=embed)

    tier = tier.lower()
    if tier not in ["free", "premium", "paid"]:
        embed = discord.Embed(title="❌ Invalid Tier", description="Choose free, premium, or paid.", color=0xED4245)
        return await ctx.send(embed=embed)

    service = normalize(service)
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)
    if len(stock) < amount:
        embed = discord.Embed(title="❌ Not Enough Stock", description=f"Only {len(stock)} accounts available.", color=0xED4245)
        return await ctx.send(embed=embed)

    stock = stock[amount:]
    github_write(path, stock)
    await ctx.send(f"✅ Removed {amount} accounts from {tier}/{service}")

    log_embed = discord.Embed(title="📝 Log: Remove Stock", description=f"{ctx.author} removed {amount} from {tier}/{service}", color=0x3498DB)
    await send_log(ctx.guild, log_embed)

# ------------------ SEND ------------------
@bot.command()
async def send(ctx: commands.Context, member: discord.Member = None, amount: int = 1, service: str = None):
    if not (is_helper(ctx.author) or is_mod(ctx.author)):
        return  # Silent ignore

    if member is None or service is None or amount < 1:
        embed = discord.Embed(title="❌ Usage", description="!send <@member> <amount> <service>", color=0xED4245)
        return await ctx.send(embed=embed)

    if not is_mod(ctx.author):
        data = load_json(SEND_COOLDOWN_FILE)
        now = int(time.time())
        user_key = str(ctx.author.id)
        uses = [t for t in data.get(user_key, []) if now - t < 3600]
        if len(uses) >= 5:
            embed = discord.Embed(title="❌ Limit Reached", description="You can only send 5 times per hour.", color=0xED4245)
            return await ctx.send(embed=embed)
        uses.append(now)
        data[user_key] = uses
        save_json(SEND_COOLDOWN_FILE, data)

    service = normalize(service)
    sent = False
    for tier in ["free", "premium", "paid"]:
        path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
        stock = github_read(path)
        if len(stock) >= amount:
            send_accounts = stock[:amount]
            stock = stock[amount:]
            github_write(path, stock)
            try:
                await member.send("📦 Accounts\n```\n" + "\n".join(send_accounts) + "\n```")
                await ctx.send(f"✅ Sent {amount} {service} accounts to {member.mention}")
                sent = True
            except discord.Forbidden:
                await ctx.send(f"❌ Cannot send DM to {member.mention} (DMs closed)")
            except Exception as e:
                await ctx.send(f"❌ Error sending: {str(e)}")
            break

    if not sent:
        await ctx.send(f"❌ Not enough stock for {service} in any tier.")

    if sent:
        log_embed = discord.Embed(title="📝 Log: Send", description=f"{ctx.author} sent {amount} {service} to {member}", color=0x3498DB)
        await send_log(ctx.guild, log_embed)

# ------------------ HELP ------------------
@bot.command()
async def help(ctx: commands.Context):
    embed = discord.Embed(title="📜 Commands", color=0x5865F2)
    embed.add_field(
        name="User Commands",
        value="""
!gen <tier> <service> - Generate an account
!profile [@user] - View profile stats
!leaderboard - Top generators
!stock - View all stock
!stock-free - View free stock
!stock-premium - View premium stock
!stock-paid - View paid stock
""",
        inline=False
    )
    embed.add_field(
        name="Staff Commands",
        value="""
!redeem <code> - Redeem a ticket
!add <tier> <service> - Add accounts (attach .txt)
!send <@user> <amount> <service> - Send accounts directly
!remove <tier> <service> <amount> - Remove accounts
""",
        inline=False
    )
    await ctx.send(embed=embed)

# Error handler for commands
@bot.event
async def on_command_error(ctx: commands.Context, error: commands.CommandError):
    if isinstance(error, commands.CommandNotFound):
        return  # Ignore unknown commands
    embed = discord.Embed(title="❌ Error", description=str(error), color=0xED4245)
    await ctx.send(embed=embed)
    raise error  # For logging

bot.run(TOKEN)
