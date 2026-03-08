import discord
from discord.ext import commands
import os
import json
import random
import string
import asyncio
from github import Github

# ---------------- CONFIG ----------------
TOKEN = os.getenv("TOKEN")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME = "TON_USER/TON_REPO"

FREE_CHANNEL = 1479204587104895060
PREMIUM_CHANNEL = 1479080682616520718
PAID_CHANNEL = 1479080682616520717
TICKET_CATEGORY = 1479080682784555134
AUTHORIZED_IDS = [1112314692258512926,1040256699480686604,1406599824089808967]

ACCOUNTS_DIR = "accounts"
PENDING_FILE = "pending.json"
STATS_FILE = "stats.json"
LOGS_CHANNEL_FILE = "logs_channel.json"

intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

github = Github(GITHUB_TOKEN)
repo = github.get_repo(REPO_NAME)

# ---------------- HELPERS ----------------
def github_read(path):
    try:
        file = repo.get_contents(path)
        return file.decoded_content.decode().splitlines()
    except:
        return []

def github_write(path,data):
    content="\n".join(data)
    try:
        file=repo.get_contents(path)
        repo.update_file(file.path,"update",content,file.sha)
    except:
        repo.create_file(path,"create",content)

def load_json(path):
    try:
        file=repo.get_contents(path)
        return json.loads(file.decoded_content.decode())
    except:
        return {}

def save_json(path,data):
    content=json.dumps(data,indent=4)
    try:
        file=repo.get_contents(path)
        repo.update_file(file.path,"update json",content,file.sha)
    except:
        repo.create_file(path,"create json",content)

def get_logs_channel(guild_id):
    data = load_json(LOGS_CHANNEL_FILE)
    return data.get(str(guild_id), None)

def log_action(guild, message):
    channel_id = get_logs_channel(guild.id)
    if channel_id:
        channel = bot.get_channel(channel_id)
        if channel:
            asyncio.create_task(channel.send(message))

# ---------------- BOT READY ----------------
@bot.event
async def on_ready():
    await bot.change_presence(activity=discord.Game("Generating Accounts"))
    print("Bot ready")

# ---------------- GEN ----------------
@bot.command()
async def gen(ctx,tier=None,service=None):
    if tier not in ["free","premium","paid"]:
        return await ctx.send("❌ Tier must be free/premium/paid")

    tier_channel = { "free":FREE_CHANNEL,"premium":PREMIUM_CHANNEL,"paid":PAID_CHANNEL }
    if ctx.channel.id != tier_channel[tier]:
        return

    service = service.lower()
    folder = f"{ACCOUNTS_DIR}/{tier}"
    os.makedirs(folder, exist_ok=True)
    path = f"{folder}/{service}.txt"

    stock = github_read(path)
    if len(stock)==0: return await ctx.send("❌ Out of stock")

    account = stock.pop(0)
    github_write(path,stock)

    code = ''.join(random.choices(string.ascii_uppercase+string.digits,k=6))
    pending = load_json(PENDING_FILE)
    pending[code] = {"account":account,"tier":tier,"service":service}
    save_json(PENDING_FILE,pending)

    category = bot.get_channel(TICKET_CATEGORY)
    overwrites = {
        ctx.guild.default_role:discord.PermissionOverwrite(read_messages=False),
        ctx.author:discord.PermissionOverwrite(read_messages=True),
        ctx.guild.me:discord.PermissionOverwrite(read_messages=True)
    }

    ticket = await ctx.guild.create_text_channel(
        name=f"{service}-{ctx.author.name}",
        category=category,
        overwrites=overwrites
    )

    embed = discord.Embed(
        title="🎫 Generation Ticket",
        description=f"Service: **{service}**\nTier: **{tier}**",
        color=discord.Color.purple()
    )
    embed.add_field(name="Redeem code", value=f"`!redeem {code}`", inline=False)
    await ticket.send(ctx.author.mention, embed=embed)
    await ctx.send(f"✅ Ticket created {ticket.mention}")

    stats = load_json(STATS_FILE)
    uid = str(ctx.author.id)
    stats[uid] = stats.get(uid,0)+1
    save_json(STATS_FILE,stats)

    log_action(ctx.guild, f"🟢 {ctx.author} generated {tier}/{service} (code: {code})")

# ---------------- REDEEM ----------------
@bot.command()
async def redeem(ctx,code=None):
    if not code: return
    code = code.upper()
    pending = load_json(PENDING_FILE)
    if code not in pending: return await ctx.send("❌ Invalid code")
    data = pending[code]

    embed = discord.Embed(
        title="📦 Your Account",
        description=f"```\n{data['account']}\n```",
        color=discord.Color.green()
    )
    try:
        await ctx.author.send(embed=embed)
        await ctx.send("✅ Check your DM")
    except:
        await ctx.send("❌ Open your DM")

    del pending[code]
    save_json(PENDING_FILE,pending)
    await asyncio.sleep(5)
    await ctx.channel.delete()

    log_action(ctx.guild, f"📩 {ctx.author} redeemed code {code}")

# ---------------- STOCK ----------------
@bot.command()
async def stock(ctx):
    msg=""
    for tier in ["free","premium","paid"]:
        try:
            contents = repo.get_contents(f"{ACCOUNTS_DIR}/{tier}")
            for file in contents:
                service=file.name.replace(".txt","")
                stock=github_read(file.path)
                msg+=f"**{tier}/{service}** : {len(stock)}\n"
        except: pass
    embed=discord.Embed(title="📦 Stock", description=msg, color=discord.Color.gold())
    await ctx.send(embed=embed)

# ---------------- ADD / REMOVE ----------------
@bot.command()
async def add(ctx, tier=None, service=None):
    if ctx.author.id not in AUTHORIZED_IDS: 
        return await ctx.send("❌ Not authorized")

    if tier not in ["free","premium","paid"]:
        return await ctx.send("❌ Tier must be free/premium/paid")

    if not ctx.message.attachments:
        return await ctx.send("❌ Attach a .txt file with accounts")

    file = ctx.message.attachments[0]
    if not file.filename.endswith(".txt"):
        return await ctx.send("❌ File must be a .txt")

    content = await file.read()
    accounts = content.decode().splitlines()

    service = service.lower()
    folder = f"{ACCOUNTS_DIR}/{tier}"
    os.makedirs(folder, exist_ok=True)
    path = f"{folder}/{service}.txt"

    stock = github_read(path)
    stock.extend(accounts)
    github_write(path, stock)

    await ctx.send(f"✅ Added {len(accounts)} accounts to {tier}/{service}")
    log_action(ctx.guild,f"➕ {ctx.author} added {len(accounts)} accounts to {tier}/{service}")

@bot.command()
async def remove(ctx,tier=None,service=None,amount:int=1):
    if ctx.author.id not in AUTHORIZED_IDS: return
    service = service.lower()
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)
    if len(stock)<amount: return await ctx.send("❌ Not enough stock")
    stock=stock[amount:]
    github_write(path,stock)
    await ctx.send(f"✅ Removed {amount} accounts from {tier}/{service}")
    log_action(ctx.guild,f"➖ {ctx.author} removed {amount} from {tier}/{service}")

# ---------------- SEND ----------------
@bot.command()
async def send(ctx,member:discord.Member=None,amount:int=None,service=None):
    if ctx.author.id not in AUTHORIZED_IDS: return
    service=service.lower()
    for tier in ["free","premium","paid"]:
        path=f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
        stock=github_read(path)
        if len(stock)>=amount:
            to_send=stock[:amount]
            stock=stock[amount:]
            github_write(path,stock)
            try:
                await member.send("📦 Accounts\n```\n"+'\n'.join(to_send)+"```")
                await ctx.send("✅ Sent")
            except:
                await ctx.send("❌ DM closed")
            log_action(ctx.guild,f"📤 {ctx.author} sent {amount} {tier}/{service} to {member}")
            return
    await ctx.send("❌ Not enough stock")

# ---------------- PROFILE / LEADERBOARD ----------------
@bot.command()
async def profile(ctx,member:discord.Member=None):
    if member is None: member=ctx.author
    stats=load_json(STATS_FILE)
    count=stats.get(str(member.id),0)
    embed=discord.Embed(title=f"{member.name} Profile", description=f"Generated: **{count}**", color=discord.Color.blue())
    await ctx.send(embed=embed)

@bot.command()
async def leaderboard(ctx):
    stats=load_json(STATS_FILE)
    sorted_stats=sorted(stats.items(), key=lambda x:x[1], reverse=True)
    embed=discord.Embed(title="🏆 Leaderboard", color=discord.Color.gold())
    for i,(uid,count) in enumerate(sorted_stats[:10],1):
        member=ctx.guild.get_member(int(uid))
        name=member.name if member else uid
        embed.add_field(name=f"{i}. {name}", value=f"{count} accounts", inline=False)
    await ctx.send(embed=embed)

# ---------------- PANEL LOGS ----------------
@bot.command()
async def setlogs(ctx,channel:discord.TextChannel=None):
    if ctx.author.id not in AUTHORIZED_IDS: return
    data=load_json(LOGS_CHANNEL_FILE)
    data[str(ctx.guild.id)] = channel.id
    save_json(LOGS_CHANNEL_FILE,data)
    await ctx.send(f"✅ Logs channel set to {channel.mention}")

bot.run(TOKEN)
