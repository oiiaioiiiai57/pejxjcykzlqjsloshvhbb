import discord
from discord.ext import commands
import os
import json
import random
import string
import asyncio
from github import Github

# ---------- CONFIG ----------
TOKEN = os.getenv("TOKEN")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME = "chevalier577pro/gen-bot"

FREE_CHANNEL = 1479204587104895060
PREMIUM_CHANNEL = 1479080682616520718
PAID_CHANNEL = 1479080682616520717
TICKET_CATEGORY = 1479080682784555134

AUTHORIZED_IDS = [
1112314692258512926,
1040256699480686604,
1406599824089808967
]

ACCOUNTS_DIR = "accounts"
PENDING_FILE = "pending.json"
STATS_FILE = "stats.json"
LOGS_FILE = "logs_channel.json"

intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

github = Github(GITHUB_TOKEN)
repo = github.get_repo(REPO_NAME)

# ---------- GITHUB UTILS ----------

def github_read(path):
    try:
        file = repo.get_contents(path)
        return [line.strip() for line in file.decoded_content.decode().splitlines() if line.strip()]
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

# ---------- LOGS ----------

def get_logs_channel(guild_id):
    data = load_json(LOGS_FILE)
    return data.get(str(guild_id))

def log_action(guild,msg):
    channel_id = get_logs_channel(guild.id)
    if channel_id:
        channel = bot.get_channel(channel_id)
        if channel:
            asyncio.create_task(channel.send(msg))

# ---------- UTILS ----------

def normalize_service(service):
    return service.capitalize()

# ---------- READY ----------

@bot.event
async def on_ready():
    print(f"Logged as {bot.user}")

# ---------- GEN ----------

@bot.command()
async def gen(ctx,tier=None,service=None):

    if tier not in ["free","premium","paid"]:
        return

    channels={
    "free":FREE_CHANNEL,
    "premium":PREMIUM_CHANNEL,
    "paid":PAID_CHANNEL
    }

    if ctx.channel.id!=channels[tier]:
        return

    service=normalize_service(service)

    path=f"{ACCOUNTS_DIR}/{tier}/{service}.txt"

    stock=github_read(path)

    if len(stock)==0:
        return await ctx.send("❌ Out of stock")

    account=stock.pop(0)
    github_write(path,stock)

    code=''.join(random.choices(string.ascii_uppercase+string.digits,k=6))

    pending=load_json(PENDING_FILE)
    pending[code]={"account":account}
    save_json(PENDING_FILE,pending)

    category=bot.get_channel(TICKET_CATEGORY)

    overwrites={
    ctx.guild.default_role:discord.PermissionOverwrite(read_messages=False),
    ctx.author:discord.PermissionOverwrite(read_messages=True),
    ctx.guild.me:discord.PermissionOverwrite(read_messages=True)
    }

    ticket=await ctx.guild.create_text_channel(
    name=f"{service}-{ctx.author.name}",
    category=category,
    overwrites=overwrites
    )

    embed=discord.Embed(
    title="🎫 Generation Ticket",
    description=f"Service : **{service}**\nTier : **{tier}**",
    color=discord.Color.purple()
    )

    embed.add_field(name="Redeem",value=f"`!redeem {code}`")

    await ticket.send(ctx.author.mention,embed=embed)

    stats=load_json(STATS_FILE)
    uid=str(ctx.author.id)
    stats[uid]=stats.get(uid,0)+1
    save_json(STATS_FILE,stats)

    log_action(ctx.guild,f"{ctx.author} generated {tier}/{service}")

# ---------- REDEEM ----------

@bot.command()
async def redeem(ctx,code=None):

    pending=load_json(PENDING_FILE)

    if code not in pending:
        return await ctx.send("❌ Invalid code")

    account=pending[code]["account"]

    try:
        await ctx.author.send(f"📦 Account\n```{account}```")
        await ctx.send("✅ Check DM")
    except:
        await ctx.send("❌ Open your DM")

    del pending[code]
    save_json(PENDING_FILE,pending)

    await asyncio.sleep(5)
    await ctx.channel.delete()

# ---------- STOCK GLOBAL ----------

@bot.command()
async def stock(ctx):

    msg=""

    for tier in ["free","premium","paid"]:

        try:
            contents=repo.get_contents(f"{ACCOUNTS_DIR}/{tier}")

            for file in contents:

                service=file.name.replace(".txt","")
                stock=github_read(file.path)

                msg+=f"**{tier}/{service}** : {len(stock)}\n"

        except:
            pass

    embed=discord.Embed(title="📦 Stock",description=msg,color=discord.Color.gold())
    await ctx.send(embed=embed)

# ---------- STOCK FREE ----------

@bot.command(name="stock-free")
async def stock_free(ctx):

    msg=""

    try:
        contents=repo.get_contents(f"{ACCOUNTS_DIR}/free")

        for file in contents:
            service=file.name.replace(".txt","")
            stock=github_read(file.path)
            msg+=f"**{service}** : {len(stock)}\n"

    except:
        msg="No stock"

    embed=discord.Embed(title="Free Stock",description=msg,color=discord.Color.green())
    await ctx.send(embed=embed)

# ---------- STOCK PREMIUM ----------

@bot.command(name="stock-premium")
async def stock_premium(ctx):

    msg=""

    try:
        contents=repo.get_contents(f"{ACCOUNTS_DIR}/premium")

        for file in contents:
            service=file.name.replace(".txt","")
            stock=github_read(file.path)
            msg+=f"**{service}** : {len(stock)}\n"

    except:
        msg="No stock"

    embed=discord.Embed(title="Premium Stock",description=msg,color=discord.Color.purple())
    await ctx.send(embed=embed)

# ---------- STOCK PAID ----------

@bot.command(name="stock-paid")
async def stock_paid(ctx):

    msg=""

    try:
        contents=repo.get_contents(f"{ACCOUNTS_DIR}/paid")

        for file in contents:
            service=file.name.replace(".txt","")
            stock=github_read(file.path)
            msg+=f"**{service}** : {len(stock)}\n"

    except:
        msg="No stock"

    embed=discord.Embed(title="Paid Stock",description=msg,color=discord.Color.gold())
    await ctx.send(embed=embed)

# ---------- ADD ----------

@bot.command()
async def add(ctx,tier=None,service=None):

    if ctx.author.id not in AUTHORIZED_IDS:
        return

    if not ctx.message.attachments:
        return await ctx.send("Attach a txt file")

    file=ctx.message.attachments[0]
    content=await file.read()

    accounts=content.decode().splitlines()

    service=normalize_service(service)

    path=f"{ACCOUNTS_DIR}/{tier}/{service}.txt"

    stock=github_read(path)
    stock.extend(accounts)

    github_write(path,stock)

    await ctx.send(f"✅ Added {len(accounts)} accounts")

# ---------- REMOVE ----------

@bot.command()
async def remove(ctx,tier=None,service=None,amount:int=1):

    if ctx.author.id not in AUTHORIZED_IDS:
        return

    service=normalize_service(service)

    path=f"{ACCOUNTS_DIR}/{tier}/{service}.txt"

    stock=github_read(path)
    stock=stock[amount:]

    github_write(path,stock)

    await ctx.send("Removed")

# ---------- SEND ----------

@bot.command()
async def send(ctx,member:discord.Member=None,amount:int=None,service=None):

    if ctx.author.id not in AUTHORIZED_IDS:
        return

    service=normalize_service(service)

    for tier in ["free","premium","paid"]:

        path=f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
        stock=github_read(path)

        if len(stock)>=amount:

            send_accounts=stock[:amount]
            stock=stock[amount:]

            github_write(path,stock)

            await member.send("\n".join(send_accounts))
            await ctx.send("✅ Sent")

            return

    await ctx.send("❌ Not enough stock")

# ---------- PROFILE ----------

@bot.command()
async def profile(ctx,member:discord.Member=None):

    if not member:
        member=ctx.author

    stats=load_json(STATS_FILE)
    count=stats.get(str(member.id),0)

    embed=discord.Embed(
    title=f"{member.name} Profile",
    description=f"Generated : **{count}**",
    color=discord.Color.blue()
    )

    await ctx.send(embed=embed)

# ---------- LEADERBOARD ----------

@bot.command()
async def leaderboard(ctx):

    stats=load_json(STATS_FILE)
    sorted_stats=sorted(stats.items(),key=lambda x:x[1],reverse=True)

    embed=discord.Embed(title="🏆 Leaderboard",color=discord.Color.gold())

    for i,(uid,count) in enumerate(sorted_stats[:10],1):

        user=ctx.guild.get_member(int(uid))
        name=user.name if user else uid

        embed.add_field(name=f"{i}. {name}",value=count)

    await ctx.send(embed=embed)

# ---------- SET LOGS ----------

@bot.command()
async def setlogs(ctx,channel:discord.TextChannel):

    if ctx.author.id not in AUTHORIZED_IDS:
        return

    data=load_json(LOGS_FILE)
    data[str(ctx.guild.id)]=channel.id
    save_json(LOGS_FILE,data)

    await ctx.send("Logs channel set")

bot.run(TOKEN)
