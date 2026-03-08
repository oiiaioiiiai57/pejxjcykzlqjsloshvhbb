import discord
from discord.ext import commands
import os
import json
import random
import string
import asyncio

TOKEN = os.getenv("TOKEN")

AUTHORIZED_IDS = [1112314692258512926,1040256699480686604,1406599824089808967]

FREE_CHANNEL = 1479204587104895060
PREMIUM_CHANNEL = 1479080682616520718
PAID_CHANNEL = 1479080682616520717

TICKET_CATEGORY = 1479080682784555134

ACCOUNTS_DIR = "accounts"
PENDING_FILE = "pending.json"

intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)


def load_json(file):
    if not os.path.exists(file):
        return {}
    with open(file) as f:
        return json.load(f)


def save_json(file,data):
    with open(file,"w") as f:
        json.dump(data,f,indent=4)


def get_stock(tier,service):

    folder=f"{ACCOUNTS_DIR}/{tier}"

    if not os.path.exists(folder):
        return []

    for file in os.listdir(folder):

        if file.lower()==f"{service}.txt":

            with open(f"{folder}/{file}") as f:
                return [x.strip() for x in f if x.strip()]

    return []


def save_stock(tier,service,data):

    folder=f"{ACCOUNTS_DIR}/{tier}"

    os.makedirs(folder,exist_ok=True)

    path=f"{folder}/{service}.txt"

    with open(path,"w") as f:
        f.write("\n".join(data))


@bot.event
async def on_ready():

    await bot.change_presence(activity=discord.Game("Generating accounts"))

    print("Bot online")


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
        "service":service,
        "tier":tier
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
        description=f"Service: **{service}**\nTier: **{tier}**",
        color=discord.Color.purple()
    )

    embed.add_field(
        name="Redeem code",
        value=f"`!redeem {code}`",
        inline=False
    )

    await ticket.send(ctx.author.mention,embed=embed)

    await ctx.send(f"✅ Ticket created {ticket.mention}")


@bot.command()
async def redeem(ctx,code=None):

    if not code:
        return

    pending=load_json(PENDING_FILE)

    code=code.upper()

    if code not in pending:
        return await ctx.send("❌ Invalid code")

    data=pending[code]

    embed=discord.Embed(
        title="📦 Your account",
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
                    "📦 Accounts\n```\n"+'\n'.join(to_send)+"```"
                )

                await ctx.send("✅ Sent")

            except:

                await ctx.send("❌ DM closed")

            return

    await ctx.send("❌ Not enough stock")


bot.run(TOKEN)
