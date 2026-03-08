import discord
from discord.ext import commands
from discord import app_commands
from discord.ui import View, Button
import os, json, random, string, asyncio, base64
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
tree = app_commands.CommandTree(bot)
g = Github(os.getenv("GITHUB_TOKEN"))
repo = g.get_repo(GITHUB_REPO)

# ---------- HELPERS ----------
async def send_log(msg):
    ch = bot.get_channel(LOG_CHANNEL_ID)
    if ch:
        await ch.send(msg)

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

CONFIG_FILE = "config.json"
def load_config():
    try:
        file = repo.get_contents(CONFIG_FILE)
        content = base64.b64decode(file.content).decode()
        return json.loads(content), file.sha
    except:
        repo.create_file(CONFIG_FILE,"create config",json.dumps({
            "log_channel": LOG_CHANNEL_ID,
            "free_channel": FREE_CHANNEL_ID
        }))
        return {"log_channel": LOG_CHANNEL_ID, "free_channel": FREE_CHANNEL_ID}, None

def save_config(config, sha):
    content = json.dumps(config, indent=4)
    if sha:
        repo.update_file(CONFIG_FILE,"update config",content,sha)
    else:
        repo.create_file(CONFIG_FILE,"create config",content)

# ---------- READY ----------
@bot.event
async def on_ready():
    await tree.sync()
    print(f"Connected as {bot.user}")

# ---------- GEN ----------
@bot.command()
async def gen(ctx, tier=None, service=None):
    config, _ = load_config()
    if ctx.channel.id != config["free_channel"]:
        return
    if tier != "free":
        return await ctx.send("Usage: !gen free <service>")

    accounts, acc_sha = load_accounts(service)
    if not accounts:
        return await ctx.send("Out of stock")

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

    await ticket.send(f"Use !redeem {code}")
    await ctx.send(f"Ticket created {ticket.mention}")

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
        return await ctx.send("Invalid code")

    data = pending_redeems[code]
    if ctx.author.id != data["user"]:
        return await ctx.send("Not your code")

    try:
        await ctx.author.send(f"{data['service']} account:\n{data['account']}")
        await ctx.send("Account sent in DM")
        await send_log(f"{ctx.author} redeemed {data['service']} | code {code}")

        del pending_redeems[code]
        save_pending(pending_redeems, pending_sha)
        await asyncio.sleep(5)
        await ctx.channel.delete()
    except:
        await ctx.send("Enable your DMs")

# ---------- STOCK ----------
@bot.command()
async def stock(ctx):
    files = repo.get_contents("accounts")
    msg = "Current Stock:\n"
    for file in files:
        content = base64.b64decode(file.content).decode()
        msg += f"{file.name.replace('.txt','')}: {len(content.splitlines())} accounts\n"
    await ctx.send(msg)

# ---------- ADD ----------
@bot.command()
async def add(ctx, service):
    if ctx.author.id not in AUTHORIZED_IDS:
        return await ctx.send("Owner only")
    if not ctx.message.attachments:
        return await ctx.send("Attach a txt file")

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

    await ctx.send(f"Added {len(new_accounts)} accounts to {service}")
    await send_log(f"{ctx.author} added {len(new_accounts)} {service}")

# ---------- PROFILE ----------
@bot.command()
async def profile(ctx, member:discord.Member=None):
    if member is None:
        member = ctx.author
    stats, _ = load_stats()
    await ctx.send(f"{member.name} generated {stats.get(str(member.id),0)} accounts")

# ---------- LEADERBOARD ----------
@bot.command()
async def leaderboard(ctx):
    stats, _ = load_stats()
    sorted_stats = sorted(stats.items(), key=lambda x:x[1], reverse=True)
    msg = "Leaderboard:\n"
    for i,(uid,count) in enumerate(sorted_stats[:10], start=1):
        member = ctx.guild.get_member(int(uid))
        msg += f"{i}. {member.name if member else uid}: {count} accounts\n"
    await ctx.send(msg)

# ---------- PANEL ----------
@bot.tree.command(name="panel", description="Open bot configuration panel")
async def panel(interaction):
    if interaction.user.id not in AUTHORIZED_IDS:
        return await interaction.response.send_message("❌ Owner only", ephemeral=True)

    config, _ = load_config()
    view = View(timeout=None)
    view.add_item(Button(label="📝 Set Log Channel", style=discord.ButtonStyle.primary, custom_id="btn_log"))
    view.add_item(Button(label="💬 Set Free Channel", style=discord.ButtonStyle.primary, custom_id="btn_free"))
    view.add_item(Button(label="📦 View Stock", style=discord.ButtonStyle.success, custom_id="btn_stock"))
    view.add_item(Button(label="➕ Modify Stock", style=discord.ButtonStyle.secondary, custom_id="btn_modify_stock"))

    await interaction.response.send_message("🛠 Bot Configuration Panel", view=view, ephemeral=True)

@bot.event
async def on_interaction(interaction):
    if interaction.type != discord.InteractionType.component:
        return
    if interaction.user.id not in AUTHORIZED_IDS:
        return await interaction.response.send_message("❌ Owner only", ephemeral=True)

    custom_id = interaction.data["custom_id"]
    config, sha = load_config()

    if custom_id == "btn_log":
        config["log_channel"] = interaction.channel_id
        save_config(config, sha)
        await interaction.response.send_message(f"✅ Log channel set to {interaction.channel.mention}", ephemeral=True)

    elif custom_id == "btn_free":
        config["free_channel"] = interaction.channel_id
        save_config(config, sha)
        await interaction.response.send_message(f"✅ Free channel set to {interaction.channel.mention}", ephemeral=True)

    elif custom_id == "btn_stock":
        files = repo.get_contents("accounts")
        msg = ""
        for file in files:
            content = base64.b64decode(file.content).decode()
            msg += f"{file.name.replace('.txt','')}: {len(content.splitlines())} accounts\n"
        await interaction.response.send_message(f"📦 Stock:\n{msg}", ephemeral=True)

    elif custom_id == "btn_modify_stock":
        await interaction.response.send_message("💡 Use !add or !remove to modify stock safely", ephemeral=True)

# ---------- RUN ----------
bot.run(os.getenv("TOKEN"))
