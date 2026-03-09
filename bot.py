import discord
from discord.ext import commands
import os
import json
import random
import string
import asyncio
from github import Github

# ------------------ CONFIG ------------------
TOKEN = os.getenv("TOKEN")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME = "chevalier577pro/gen-bot"  # repo GitHub pour stocks et JSON

# Channels
FREE_CHANNEL = 1479204587104895060
PREMIUM_CHANNEL = 1479080682616520718
PAID_CHANNEL = 1479080682616520717
TICKET_CATEGORY = 1479080682784555134

# Admins
AUTHORIZED_IDS = [
    1112314692258512926,
    1040256699480686604,
    1406599824089808967
]

# ------------------ INIT ------------------
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

github = Github(GITHUB_TOKEN)
repo = github.get_repo(REPO_NAME)

ACCOUNTS_DIR = "accounts"
PENDING_FILE = "pending.json"
STATS_FILE = "stats.json"
LOGS_FILE = "logs_channel.json"

# ------------------ GITHUB ------------------
def github_read(path):
    try:
        file = repo.get_contents(path)
        return [l.strip() for l in file.decoded_content.decode().splitlines() if l.strip()]
    except:
        return []

def github_write(path, data):
    content = "\n".join(data)
    try:
        file = repo.get_contents(path)
        repo.update_file(file.path, "update", content, file.sha)
    except:
        repo.create_file(path, "create", content)

def load_json(path):
    try:
        file = repo.get_contents(path)
        return json.loads(file.decoded_content.decode())
    except:
        return {}

def save_json(path, data):
    content = json.dumps(data, indent=4)
    try:
        file = repo.get_contents(path)
        repo.update_file(file.path, "update", content, file.sha)
    except:
        repo.create_file(path, "create", content)

# ------------------ UTILS ------------------
def normalize(service):
    return service.capitalize()

# ------------------ READY ------------------
@bot.event
async def on_ready():
    print(f"Bot connecté : {bot.user}")
    await bot.change_presence(activity=discord.Game("Playing with code 😎"))

# ------------------ GEN ------------------
@bot.command()
async def gen(ctx, tier=None, service=None):
    if tier not in ["free", "premium", "paid"]:
        return
    channels = {"free": FREE_CHANNEL, "premium": PREMIUM_CHANNEL, "paid": PAID_CHANNEL}
    if ctx.channel.id != channels[tier]:
        return

    service = normalize(service)
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)
    if len(stock) == 0:
        return await ctx.send("❌ Out of stock")

    account = stock.pop(0)
    github_write(path, stock)

    code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    pending = load_json(PENDING_FILE)
    pending[code] = {"account": account}
    save_json(PENDING_FILE, pending)

    category = bot.get_channel(TICKET_CATEGORY)
    overwrites = {
        ctx.guild.default_role: discord.PermissionOverwrite(read_messages=False),
        ctx.author: discord.PermissionOverwrite(read_messages=True),
        ctx.guild.me: discord.PermissionOverwrite(read_messages=True)
    }

    ticket = await ctx.guild.create_text_channel(
        name=f"{service}-{ctx.author.name}",
        category=category,
        overwrites=overwrites
    )

    # Embed dans le ticket
    ticket_embed = discord.Embed(
        title="🎟 Generation Ticket",
        description=f"Service: **{service}**\nTier: **{tier.upper()}**",
        color=0x5865F2
    )
    ticket_embed.add_field(name="Redeem", value=f"`!redeem {code}`", inline=False)
    ticket_embed.set_footer(text="Use the command above to receive your account")
    await ticket.send(ctx.author.mention, embed=ticket_embed)

    # Confirmation dans le salon gen
    confirm_embed = discord.Embed(
        title="✅ Ticket Created",
        description=f"{ctx.author.mention}, your ticket has been created!",
        color=0x57F287
    )
    confirm_embed.add_field(name="Ticket", value=ticket.mention, inline=False)
    await ctx.send(embed=confirm_embed)

    # Stats
    stats = load_json(STATS_FILE)
    uid = str(ctx.author.id)
    stats[uid] = stats.get(uid, 0) + 1
    save_json(STATS_FILE, stats)

# ------------------ REDEEM ------------------
@bot.command()
async def redeem(ctx, code=None):
    pending = load_json(PENDING_FILE)
    if code not in pending:
        return await ctx.send("❌ Invalid code")

    account = pending[code]["account"]
    embed = discord.Embed(
        title="📦 Your Account",
        description=f"```{account}```",
        color=0x57F287
    )
    try:
        await ctx.author.send(embed=embed)
        await ctx.send("✅ Check your DM")
    except:
        await ctx.send("❌ Open your DM")

    del pending[code]
    save_json(PENDING_FILE, pending)
    await asyncio.sleep(5)
    await ctx.channel.delete()

# ------------------ STOCK ------------------
@bot.command()
async def stock(ctx):
    msg = ""
    for tier in ["free", "premium", "paid"]:
        try:
            files = repo.get_contents(f"{ACCOUNTS_DIR}/{tier}")
            for f in files:
                service = f.name.replace(".txt", "")
                stock = len(github_read(f.path))
                msg += f"**{tier.upper()} | {service}** : {stock}\n"
        except:
            pass
    embed = discord.Embed(title="📦 Global Stock", description=msg, color=0xFEE75C)
    await ctx.send(embed=embed)

@bot.command(name="stock-free")
async def stock_free(ctx):
    msg = ""
    try:
        files = repo.get_contents(f"{ACCOUNTS_DIR}/free")
        for f in files:
            service = f.name.replace(".txt", "")
            stock = len(github_read(f.path))
            msg += f"**{service}** : {stock}\n"
    except:
        msg = "No stock"
    embed = discord.Embed(title="🟢 Free Stock", description=msg, color=0x57F287)
    await ctx.send(embed=embed)

@bot.command(name="stock-premium")
async def stock_premium(ctx):
    msg = ""
    try:
        files = repo.get_contents(f"{ACCOUNTS_DIR}/premium")
        for f in files:
            service = f.name.replace(".txt", "")
            stock = len(github_read(f.path))
            msg += f"**{service}** : {stock}\n"
    except:
        msg = "No stock"
    embed = discord.Embed(title="🟣 Premium Stock", description=msg, color=0x9B59B6)
    await ctx.send(embed=embed)

@bot.command(name="stock-paid")
async def stock_paid(ctx):
    msg = ""
    try:
        files = repo.get_contents(f"{ACCOUNTS_DIR}/paid")
        for f in files:
            service = f.name.replace(".txt", "")
            stock = len(github_read(f.path))
            msg += f"**{service}** : {stock}\n"
    except:
        msg = "No stock"
    embed = discord.Embed(title="🟡 Paid Stock", description=msg, color=0xF1C40F)
    await ctx.send(embed=embed)

# ------------------ PROFILE ------------------
@bot.command()
async def profile(ctx, member: discord.Member = None):
    member = member or ctx.author
    stats = load_json(STATS_FILE)
    count = stats.get(str(member.id), 0)
    embed = discord.Embed(title="👤 Profile", color=0x3498DB)
    embed.add_field(name="User", value=member.mention)
    embed.add_field(name="Generations", value=count)
    embed.set_thumbnail(url=member.avatar.url)
    await ctx.send(embed=embed)

# ------------------ LEADERBOARD ------------------
@bot.command()
async def leaderboard(ctx):
    stats = load_json(STATS_FILE)
    sorted_stats = sorted(stats.items(), key=lambda x: x[1], reverse=True)
    embed = discord.Embed(title="🏆 Leaderboard", color=0xF1C40F)
    for i, (uid, count) in enumerate(sorted_stats[:10], 1):
        user = ctx.guild.get_member(int(uid))
        name = user.name if user else uid
        embed.add_field(name=f"{i}. {name}", value=f"{count} gens", inline=False)
    await ctx.send(embed=embed)

# ------------------ ADD ------------------
@bot.command()
async def add(ctx, tier=None, service=None):
    if ctx.author.id not in AUTHORIZED_IDS:
        return
    if not ctx.message.attachments:
        return await ctx.send("Attach file")
    attachment = ctx.message.attachments[0]
    data = await attachment.read()
    lines = data.decode().splitlines()
    os.makedirs(f"{ACCOUNTS_DIR}/{tier}", exist_ok=True)
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)
    stock += lines
    github_write(path, stock)
    await ctx.send(f"✅ Added {len(lines)} accounts to {service}")

# ------------------ REMOVE ------------------
@bot.command()
async def remove(ctx, tier=None, service=None, amount: int = 1):
    if ctx.author.id not in AUTHORIZED_IDS:
        return
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)
    if len(stock) < amount:
        return await ctx.send("❌ Not enough stock")
    stock = stock[amount:]
    github_write(path, stock)
    await ctx.send(f"✅ Removed {amount} accounts from {service}")

# ------------------ SEND ------------------
@bot.command()
async def send(ctx, member: discord.Member = None, amount: int = 1, service=None):
    if ctx.author.id not in AUTHORIZED_IDS:
        return
    for tier in ["free", "premium", "paid"]:
        path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
        stock = github_read(path)
        if len(stock) >= amount:
            send_accounts = stock[:amount]
            stock = stock[amount:]
            github_write(path, stock)
            await member.send("📦 Accounts\n```\n" + "\n".join(send_accounts) + "\n```")
            await ctx.send("✅ Sent")
            return
    await ctx.send("❌ Not enough stock")

# ------------------ SETLOGS ------------------
@bot.command()
async def setlogs(ctx, channel: discord.TextChannel):
    if ctx.author.id not in AUTHORIZED_IDS:
        return
    data = load_json(LOGS_FILE)
    data[str(ctx.guild.id)] = channel.id
    save_json(LOGS_FILE, data)
    await ctx.send(f"✅ Logs channel set to {channel.mention}")

bot.run(TOKEN)
