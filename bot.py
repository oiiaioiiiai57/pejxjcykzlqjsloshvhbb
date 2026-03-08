import discord
from discord.ext import commands
from github import Github
import os
import json
import base64
import random
import string
import asyncio

intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

AUTHORIZED_IDS = [
1112314692258512926,
1040256699480686604,
1406599824089808967
]

TICKET_CATEGORY_ID = 1479080682784555134
FREE_CHANNEL_ID = 1479204587104895060
LOG_CHANNEL_ID = 1479239531499880628

# -------- GITHUB --------

GITHUB_REPO = "chevalier5771/gen-bot"

g = Github(os.getenv("GITHUB_TOKEN"))
repo = g.get_repo(GITHUB_REPO)

pending_redeems = {}

# -------- GITHUB FILE FUNCTIONS --------

def get_file(path):

    file = repo.get_contents(path)
    content = base64.b64decode(file.content).decode()

    return content, file.sha


def update_file(path, content, sha):

    repo.update_file(
        path,
        "update by bot",
        content,
        sha
    )

# -------- STATS --------

def load_stats():

    try:

        content, sha = get_file("stats.json")
        data = json.loads(content)

        return data, sha

    except:

        return {}, None


def save_stats(stats, sha):

    content = json.dumps(stats, indent=4)

    if sha:

        update_file("stats.json", content, sha)

    else:

        repo.create_file("stats.json", "create stats", content)

# -------- STOCK --------

def load_accounts(service):

    content, sha = get_file(f"accounts/{service}.txt")
    accounts = content.splitlines()

    return accounts, sha


def save_accounts(service, accounts, sha):

    content = "\n".join(accounts)

    update_file(f"accounts/{service}.txt", content, sha)

# -------- READY --------

@bot.event
async def on_ready():

    print(f"Connected as {bot.user}")

# -------- GEN --------

@bot.command()
async def gen(ctx, tier=None, service=None):

    if ctx.channel.id != FREE_CHANNEL_ID:
        return

    if tier != "free":
        return await ctx.send("Usage: !gen free service")

    accounts, sha = load_accounts(service)

    if len(accounts) == 0:
        return await ctx.send("Out of stock")

    acc = accounts.pop(0)

    save_accounts(service, accounts, sha)

    code = ''.join(random.choices(string.ascii_uppercase, k=4))

    pending_redeems[code] = {
        "account": acc,
        "user": ctx.author.id,
        "service": service
    }

    category = bot.get_channel(TICKET_CATEGORY_ID)

    overwrites = {
    ctx.guild.default_role: discord.PermissionOverwrite(read_messages=False),
    ctx.author: discord.PermissionOverwrite(read_messages=True),
    ctx.guild.me: discord.PermissionOverwrite(read_messages=True)
    }

    ticket = await ctx.guild.create_text_channel(
    name=f"redeem-{code.lower()}",
    category=category,
    overwrites=overwrites
    )

    await ticket.send(f"Use `!redeem {code}`")

    await ctx.send(f"Ticket created {ticket.mention}")

    stats, stats_sha = load_stats()

    uid = str(ctx.author.id)

    stats[uid] = stats.get(uid,0) + 1

    save_stats(stats, stats_sha)

# -------- REDEEM --------

@bot.command()
async def redeem(ctx, code=None):

    if code is None:
        return

    code = code.upper()

    if code not in pending_redeems:
        return await ctx.send("Invalid code")

    data = pending_redeems[code]

    if ctx.author.id != data["user"]:
        return await ctx.send("Not your code")

    try:

        await ctx.author.send(
        f"{data['service']} account:\n{data['account']}"
        )

        await ctx.send("Account sent in DM")

        del pending_redeems[code]

        await asyncio.sleep(5)

        await ctx.channel.delete()

    except:

        await ctx.send("Enable your DMs")

# -------- STOCK --------

@bot.command()
async def stock(ctx):

    files = repo.get_contents("accounts")

    embed = discord.Embed(title="Stock", color=0x00ff00)

    for file in files:

        content = base64.b64decode(file.content).decode()

        count = len(content.splitlines())

        embed.add_field(
        name=file.name.replace(".txt",""),
        value=f"{count} accounts"
        )

    await ctx.send(embed=embed)

# -------- ADD --------

@bot.command()
async def add(ctx, service):

    if ctx.author.id not in AUTHORIZED_IDS:
        return

    if not ctx.message.attachments:
        return

    attachment = ctx.message.attachments[0]

    data = await attachment.read()

    new_accounts = data.decode().splitlines()

    accounts, sha = load_accounts(service)

    accounts.extend(new_accounts)

    save_accounts(service, accounts, sha)

    await ctx.send(f"Added {len(new_accounts)} accounts")

# -------- REMOVE --------

@bot.command()
async def remove(ctx, service, amount:int):

    if ctx.author.id not in AUTHORIZED_IDS:
        return

    accounts, sha = load_accounts(service)

    removed = accounts[:amount]

    accounts = accounts[amount:]

    save_accounts(service, accounts, sha)

    await ctx.send(f"Removed {len(removed)} accounts")

# -------- SEND --------

@bot.command()
async def send(ctx, amount:int, service, member:discord.Member):

    if ctx.author.id not in AUTHORIZED_IDS:
        return

    accounts, sha = load_accounts(service)

    if len(accounts) < amount:
        return await ctx.send("Not enough stock")

    send_acc = accounts[:amount]

    accounts = accounts[amount:]

    save_accounts(service, accounts, sha)

    msg = "\n".join(send_acc)

    await member.send(msg)

    await ctx.send("Accounts sent")

# -------- PROFILE --------

@bot.command()
async def profile(ctx, member:discord.Member=None):

    if member is None:
        member = ctx.author

    stats, sha = load_stats()

    count = stats.get(str(member.id),0)

    await ctx.send(
    f"{member.name} generated {count} accounts"
    )

# -------- LEADERBOARD --------

@bot.command()
async def leaderboard(ctx):

    stats, sha = load_stats()

    sorted_stats = sorted(
    stats.items(),
    key=lambda x: x[1],
    reverse=True
    )

    embed = discord.Embed(
    title="Leaderboard",
    color=0xffd700
    )

    for i,(uid,count) in enumerate(sorted_stats[:10], start=1):

        member = ctx.guild.get_member(int(uid))

        name = member.name if member else uid

        embed.add_field(
        name=f"{i}. {name}",
        value=f"{count} accounts"
        )

    await ctx.send(embed=embed)

# -------- RUN --------

bot.run(os.getenv("TOKEN"))
