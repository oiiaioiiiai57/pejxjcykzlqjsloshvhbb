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

AUTHORIZED_IDS = [1112314692258512926,1040256699480686604,1406599824089808967]

FREE_CHANNEL = 1479204587104895060
PREMIUM_CHANNEL = 1479080682616520718
PAID_CHANNEL = 1479080682616520717

TICKET_CATEGORY = 1479080682784555134

ACCOUNTS_DIR = "accounts"
PENDING_FILE = "pending.json"
STATS_FILE = "stats.json"

intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

github = Github(GITHUB_TOKEN)
repo = github.get_repo(REPO_NAME)


def load_json(file):
    try:
        contents = repo.get_contents(file)
        return json.loads(contents.decoded_content.decode())
    except:
        return {}

def save_json(file,data):
    content=json.dumps(data,indent=4)
    try:
        contents=repo.get_contents(file)
        repo.update_file(contents.path,"update",content,contents.sha)
    except:
        repo.create_file(file,"create",content)

def get_stock(tier,service):
    path=f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return f.read().splitlines()

def save_stock(tier,service,data):
    path=f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    os.makedirs(os.path.dirname(path),exist_ok=True)
    with open(path,"w") as f:
        f.write("\n".join(data))


@bot.event
async def on_ready():
    await bot.change_presence(activity=discord.Game("Managing Stock"))
    print("Bot ready")


@bot.command()
async def gen(ctx,tier=None,service=None):

    if tier not in ["free","premium","paid"]:
        return

    if tier=="free" and ctx.channel.id!=FREE_CHANNEL:
        return
    if tier=="premium" and ctx.channel.id!=PREMIUM_CHANNEL:
        return
    if tier=="paid" and ctx.channel.id!=PAID_CHANNEL:
        return

    service=service.lower()

    stock=get_stock(tier,service)

    if len(stock)==0:
        return await ctx.send("❌ Out of stock")

    account=stock.pop(0)
    save_stock(tier,service,stock)

    code=''.join(random.choices(string.ascii_uppercase+string.digits,k=6))

    pending=load_json(PENDING_FILE)
    pending[code]={
        "account":account,
        "tier":tier,
        "service":service
    }
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

    embed.add_field(
        name="Redeem",
        value=f"`!redeem {code}`",
        inline=False
    )

    await ticket.send(ctx.author.mention,embed=embed)

    await ctx.send(f"✅ Ticket created {ticket.mention}")

    stats=load_json(STATS_FILE)
    uid=str(ctx.author.id)
    stats[uid]=stats.get(uid,0)+1
    save_json(STATS_FILE,stats)


@bot.command()
async def redeem(ctx,code=None):

    pending=load_json(PENDING_FILE)

    code=code.upper()

    if code not in pending:
        return await ctx.send("❌ Invalid code")

    data=pending[code]

    embed=discord.Embed(
        title="📨 Your Account",
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


@bot.command()
async def send(ctx,member:discord.Member=None,amount:int=None,service=None):

    if ctx.author.id not in AUTHORIZED_IDS:
        return

    service=service.lower()

    for tier in ["free","premium","paid"]:

        stock=get_stock(tier,service)

        if len(stock)>=amount:

            to_send=stock[:amount]
            stock=stock[amount:]

            save_stock(tier,service,stock)

            try:
                await member.send(
                    f"📦 {service} accounts\n```\n"+'\n'.join(to_send)+"```"
                )
                await ctx.send("✅ Sent")
            except:
                await ctx.send("❌ DM closed")

            return

    await ctx.send("❌ Not enough stock")


@bot.command()
async def stock(ctx):

    msg=""

    for tier in ["free","premium","paid"]:

        folder=f"{ACCOUNTS_DIR}/{tier}"

        if not os.path.exists(folder):
            continue

        for file in os.listdir(folder):

            service=file.replace(".txt","")

            with open(f"{folder}/{file}") as f:
                count=len(f.readlines())

            msg+=f"• {tier}/{service} : {count}\n"

    embed=discord.Embed(
        title="📦 Stock",
        description=msg,
        color=discord.Color.gold()
    )

    await ctx.send(embed=embed)


@bot.command()
async def profile(ctx,member:discord.Member=None):

    if member is None:
        member=ctx.author

    stats=load_json(STATS_FILE)

    count=stats.get(str(member.id),0)

    embed=discord.Embed(
        title=f"{member.name} profile",
        description=f"Generated : **{count}**",
        color=discord.Color.blue()
    )

    await ctx.send(embed=embed)


@bot.command()
async def leaderboard(ctx):

    stats=load_json(STATS_FILE)

    sorted_stats=sorted(stats.items(),key=lambda x:x[1],reverse=True)

    embed=discord.Embed(
        title="🏆 Leaderboard",
        color=discord.Color.gold()
    )

    for i,(uid,count) in enumerate(sorted_stats[:10],1):

        member=ctx.guild.get_member(int(uid))

        name=member.name if member else uid

        embed.add_field(
            name=f"{i}. {name}",
            value=f"{count} accounts",
            inline=False
        )

    await ctx.send(embed=embed)


bot.run(TOKEN)
