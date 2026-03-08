import discord
from discord.ext import commands
import os, json, random, string, asyncio, requests, base64
from github import Github

# ---------- CONFIG ----------
AUTHORIZED_IDS = [1112314692258512926,1040256699480686604,1406599824089808967]
TICKET_CATEGORY_ID = 1479080682784555134
FREE_CHANNEL_ID = 1479204587104895060
LOG_CHANNEL_ID = 1479239531499880628
GITHUB_REPO = "chevalier577pro/gen-bot"

# ---------- DISCORD & GITHUB ----------
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)
g = Github(os.getenv("GITHUB_TOKEN"))
repo = g.get_repo(GITHUB_REPO)

# ---------- LOGS ----------
async def send_log(msg):
    ch = bot.get_channel(LOG_CHANNEL_ID)
    if ch:
        await ch.send(msg)

# ---------- GITHUB HELPERS ----------
def load_stats():
    try:
        file = repo.get_contents("stats.json")
        content = base64.b64decode(file.content).decode()
        return json.loads(content), file.sha
    except:
        repo.create_file("stats.json","create stats","{}")
        return {}, None

def save_stats(stats, sha):
    content = json.dumps(stats, indent=4)
    if sha:
        repo.update_file("stats.json","update stats",content,sha)
    else:
        repo.create_file("stats.json","create stats",content)

def load_accounts(service):
    path = f"accounts/{service}.txt"
    try:
        file = repo.get_contents(path)
        content = base64.b64decode(file.content).decode()
        return content.splitlines(), file.sha
    except:
        repo.create_file(path,"create service file","")
        return [], None

def save_accounts(service, accounts, sha):
    path = f"accounts/{service}.txt"
    content = "\n".join(accounts)
    if sha:
        repo.update_file(path,"update stock",content,sha)
    else:
        repo.create_file(path,"create stock",content)

def load_pending():
    try:
        file = repo.get_contents("pending.json")
        content = base64.b64decode(file.content).decode()
        return json.loads(content), file.sha
    except:
        repo.create_file("pending.json","create pending","{}")
        return {}, None

def save_pending(pending, sha):
    content = json.dumps(pending, indent=4)
    if sha:
        repo.update_file("pending.json","update pending",content,sha)
    else:
        repo.create_file("pending.json","create pending",content)

# ---------- READY ----------
@bot.event
async def on_ready():
    print(f"Connected as {bot.user}")

# ---------- GEN ----------
@bot.command()
async def gen(ctx, tier=None, service=None):
    if ctx.channel.id != FREE_CHANNEL_ID:
        return
    if tier != "free":
        return await ctx.send("❌ Usage: `!gen free <service>`")

    accounts, acc_sha = load_accounts(service)
    if not accounts:
        embed = discord.Embed(title="❌ Out of Stock", description=f"No accounts available for **{service}**.", color=0xff0000)
        return await ctx.send(embed=embed)

    acc = accounts.pop(0)
    save_accounts(service, accounts, acc_sha)

    code = ''.join(random.choices(string.ascii_uppercase, k=4))
    pending_redeems, pending_sha = load_pending()
    pending_redeems[code] = {"account": acc, "user": ctx.author.id, "service": service}
    save_pending(pending_redeems, pending_sha)

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

    embed = discord.Embed(
        title="🎫 Ticket Generated!",
        description=f"Hello {ctx.author.mention}, here’s your code for **{service.upper()}**!",
        color=0x2f3136
    )
    embed.add_field(name="🔑 Your Code", value=f"`{code}`", inline=False)
    embed.set_footer(text="Use your ticket to redeem your account!")
    embed.set_thumbnail(url=ctx.author.avatar.url)
    await ticket.send(embed=embed)
    
    embed_msg = discord.Embed(
        title="✅ Ticket Created!",
        description=f"{ctx.author.mention}, your ticket has been created: {ticket.mention}",
        color=0x00ff00
    )
    await ctx.send(embed=embed_msg)

    stats, stats_sha = load_stats()
    stats[str(ctx.author.id)] = stats.get(str(ctx.author.id), 0) + 1
    save_stats(stats, stats_sha)
    await send_log(f"{ctx.author} generated {service} | code {code}")

# ---------- REDEEM ----------
@bot.command()
async def redeem(ctx, code=None):
    if not code:
        return
    code = code.upper().strip()
    pending_redeems, pending_sha = load_pending()
    if code not in pending_redeems:
        embed = discord.Embed(title="❌ Invalid Code", description="The code you entered does not exist.", color=0xff0000)
        return await ctx.send(embed=embed)

    data = pending_redeems[code]
    if ctx.author.id != data["user"]:
        embed = discord.Embed(title="❌ Not Yours", description="You cannot redeem a code that isn’t yours.", color=0xff0000)
        return await ctx.send(embed=embed)

    try:
        await ctx.author.send(f"💬 Your **{data['service'].upper()}** account:\n`{data['account']}`")
        embed = discord.Embed(title="✅ Redeemed!", description="Check your DMs for your account!", color=0x00ff00)
        await ctx.send(embed=embed)
        await send_log(f"{ctx.author} redeemed {data['service']} | code {code}")

        del pending_redeems[code]
        save_pending(pending_redeems, pending_sha)
        await asyncio.sleep(5)
        await ctx.channel.delete()
    except:
        embed = discord.Embed(title="❌ DMs Closed", description="Please enable your DMs to receive your account.", color=0xff0000)
        await ctx.send(embed=embed)

# ---------- STOCK ----------
@bot.command()
async def stock(ctx):
    files = repo.get_contents("accounts")
    embed = discord.Embed(title="📦 Current Stock", color=0x00ff00)
    for file in files:
        content = base64.b64decode(file.content).decode()
        embed.add_field(name=file.name.replace(".txt","").upper(), value=f"`{len(content.splitlines())}` accounts", inline=True)
    embed.set_footer(text="Keep track of your inventory!")
    await ctx.send(embed=embed)

# ---------- ADD ----------
@bot.command()
async def add(ctx, service):
    if ctx.author.id not in AUTHORIZED_IDS:
        return await ctx.send("❌ Owner only")
    if not ctx.message.attachments:
        return await ctx.send("❌ Attach a txt file")

    attachment = ctx.message.attachments[0]
    data = await attachment.read()
    new_accounts = data.decode().splitlines()

    path = f"accounts/{service}.txt"
    try:
        file = repo.get_contents(path)
        accounts = base64.b64decode(file.content).decode().splitlines()
        accounts.extend(new_accounts)
        repo.update_file(path,"update accounts","\n".join(accounts),file.sha)
    except:
        repo.create_file(path,"create accounts","\n".join(new_accounts))

    embed = discord.Embed(title="✅ Accounts Added", description=f"{len(new_accounts)} accounts added to **{service}**.", color=0x00ff00)
    await ctx.send(embed=embed)
    await send_log(f"{ctx.author} added {len(new_accounts)} {service}")

# ---------- PROFILE ----------
@bot.command()
async def profile(ctx, member:discord.Member=None):
    if member is None:
        member = ctx.author
    stats, _ = load_stats()
    embed = discord.Embed(title=f"📊 Profile: {member.name}", color=0x00ffff)
    embed.add_field(name="Accounts Generated", value=f"{stats.get(str(member.id),0)}", inline=False)
    embed.set_thumbnail(url=member.avatar.url)
    embed.set_footer(text="Gen Bot Stats")
    await ctx.send(embed=embed)

# ---------- LEADERBOARD ----------
@bot.command()
async def leaderboard(ctx):
    stats, _ = load_stats()
    sorted_stats = sorted(stats.items(), key=lambda x:x[1], reverse=True)
    embed = discord.Embed(title="🏆 Leaderboard", color=0xffd700)
    for i,(uid,count) in enumerate(sorted_stats[:10], start=1):
        member = ctx.guild.get_member(int(uid))
        embed.add_field(name=f"{i}. {member.name if member else uid}", value=f"{count} accounts", inline=False)
    embed.set_footer(text="Top 10 Generators")
    await ctx.send(embed=embed)

# ---------- RUN ----------
bot.run(os.getenv("TOKEN"))

