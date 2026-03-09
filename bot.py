import discord
from discord.ext import commands
import os
import json
import random
import string
import asyncio
from github import Github

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

ACCOUNTS_DIR="accounts"
PENDING_FILE="pending.json"
STATS_FILE="stats.json"
LOGS_FILE="logs_channel.json"

intents=discord.Intents.all()
bot=commands.Bot(command_prefix="!",intents=intents)

github=Github(GITHUB_TOKEN)
repo=github.get_repo(REPO_NAME)

# ---------------- GITHUB ----------------

def github_read(path):
    try:
        file=repo.get_contents(path)
        return [l.strip() for l in file.decoded_content.decode().splitlines() if l.strip()]
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
        repo.update_file(file.path,"update",content,file.sha)
    except:
        repo.create_file(path,"create",content)

# ---------------- UTILS ----------------

def normalize(service):
    return service.capitalize()

# ---------------- READY ----------------

@bot.event
async def on_ready():
    print(f"Bot connecté : {bot.user}")

# ---------------- GEN ----------------

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

    service=normalize(service)

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
    title="🎟 Generation Ticket",
    description=f"Service : **{service}**\nTier : **{tier.upper()}**",
    color=0x5865F2
    )

    embed.add_field(name="Redeem code",value=f"`!redeem {code}`")

    embed.set_footer(text="Use this command to receive your account")

    await ticket.send(ctx.author.mention,embed=embed)

    confirm=discord.Embed(
    title="✅ Ticket Created",
    description=f"{ctx.author.mention} your ticket is ready",
    color=0x57F287
    )

    confirm.add_field(name="Ticket",value=ticket.mention)

    await ctx.send(embed=confirm)

    stats=load_json(STATS_FILE)
    uid=str(ctx.author.id)
    stats[uid]=stats.get(uid,0)+1
    save_json(STATS_FILE,stats)

# ---------------- REDEEM ----------------

@bot.command()
async def redeem(ctx,code=None):

    pending=load_json(PENDING_FILE)

    if code not in pending:
        return await ctx.send("❌ Invalid code")

    account=pending[code]["account"]

    embed=discord.Embed(
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
    save_json(PENDING_FILE,pending)

    await asyncio.sleep(5)
    await ctx.channel.delete()

# ---------------- STOCK GLOBAL ----------------

@bot.command()
async def stock(ctx):

    msg=""

    for tier in ["free","premium","paid"]:

        try:
            files=repo.get_contents(f"{ACCOUNTS_DIR}/{tier}")

            for f in files:
                service=f.name.replace(".txt","")
                stock=len(github_read(f.path))

                msg+=f"**{tier.upper()} | {service}** : {stock}\n"

        except:
            pass

    embed=discord.Embed(
    title="📦 Global Stock",
    description=msg,
    color=0xFEE75C
    )

    await ctx.send(embed=embed)

# ---------------- STOCK FREE ----------------

@bot.command(name="stock-free")
async def stock_free(ctx):

    msg=""

    try:
        files=repo.get_contents(f"{ACCOUNTS_DIR}/free")

        for f in files:
            service=f.name.replace(".txt","")
            stock=len(github_read(f.path))
            msg+=f"**{service}** : {stock}\n"

    except:
        msg="No stock"

    embed=discord.Embed(title="🟢 Free Stock",description=msg,color=0x57F287)

    await ctx.send(embed=embed)

# ---------------- STOCK PREMIUM ----------------

@bot.command(name="stock-premium")
async def stock_premium(ctx):

    msg=""

    try:
        files=repo.get_contents(f"{ACCOUNTS_DIR}/premium")

        for f in files:
            service=f.name.replace(".txt","")
            stock=len(github_read(f.path))
            msg+=f"**{service}** : {stock}\n"

    except:
        msg="No stock"

    embed=discord.Embed(title="🟣 Premium Stock",description=msg,color=0x9B59B6)

    await ctx.send(embed=embed)

# ---------------- STOCK PAID ----------------

@bot.command(name="stock-paid")
async def stock_paid(ctx):

    msg=""

    try:
        files=repo.get_contents(f"{ACCOUNTS_DIR}/paid")

        for f in files:
            service=f.name.replace(".txt","")
            stock=len(github_read(f.path))
            msg+=f"**{service}** : {stock}\n"

    except:
        msg="No stock"

    embed=discord.Embed(title="🟡 Paid Stock",description=msg,color=0xF1C40F)

    await ctx.send(embed=embed)

# ---------------- PROFILE ----------------

@bot.command()
async def profile(ctx,member:discord.Member=None):

    if not member:
        member=ctx.author

    stats=load_json(STATS_FILE)
    count=stats.get(str(member.id),0)

    embed=discord.Embed(
    title="👤 Profile",
    color=0x3498DB
    )

    embed.add_field(name="User",value=member.mention)
    embed.add_field(name="Generations",value=count)

    embed.set_thumbnail(url=member.avatar.url)

    await ctx.send(embed=embed)

# ---------------- LEADERBOARD ----------------

@bot.command()
async def leaderboard(ctx):

    stats=load_json(STATS_FILE)
    sorted_stats=sorted(stats.items(),key=lambda x:x[1],reverse=True)

    embed=discord.Embed(title="🏆 Leaderboard",color=0xF1C40F)

    for i,(uid,count) in enumerate(sorted_stats[:10],1):

        user=ctx.guild.get_member(int(uid))
        name=user.name if user else uid

        embed.add_field(name=f"{i}. {name}",value=f"{count} gens",inline=False)

    await ctx.send(embed=embed)

bot.run(TOKEN)
