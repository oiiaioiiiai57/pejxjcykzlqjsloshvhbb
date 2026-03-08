import discord
from discord.ext import commands, tasks
from discord.ui import View, Select
import os, json, random, string, asyncio, shutil
from github import Github

# ---------------- CONFIG ----------------
AUTHORIZED_IDS = [1112314692258512926,1040256699480686604,1406599824089808967]
GITHUB_REPO = "chevalier577pro/gen-bot"
CONFIG_FILE = "config.json"
ACCOUNTS_DIR = "accounts"
PENDING_FILE = "pending.json"
STATS_FILE = "stats.json"
TICKET_CATEGORY_IDS = {
    "free": 1479204587104895060,
    "premium": 1479080682616520718,
    "paid": 1479080682616520717
}

# ---------------- DISCORD ----------------
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

# ---------------- GITHUB ----------------
gh = Github(os.getenv("GITHUB_TOKEN"))
repo = gh.get_repo(GITHUB_REPO)

def github_read_file(path, default={}):
    try:
        contents = repo.get_contents(path)
        data = contents.decoded_content.decode()
        # Enlever crochets si présents
        if data.startswith("[") and data.endswith("]"):
            data = data[1:-1]
        return json.loads(data) if data else default
    except:
        github_write_file(path, default, "Init file")
        return default

def github_write_file(path, data, msg="Update file"):
    content = json.dumps(data, indent=4)
    try:
        contents = repo.get_contents(path)
        repo.update_file(contents.path, msg, content, contents.sha)
    except:
        try:
            repo.create_file(path, msg, content)
        except Exception as e:
            print(f"GitHub write failed: {e}")

def load_json(path, default={}):
    return github_read_file(path, default)

def save_json(path, data):
    github_write_file(path, data, "Update "+path)

def send_log(msg):
    cfg = load_json(CONFIG_FILE)
    ch_id = cfg.get("log_channel")
    if ch_id:
        ch = bot.get_channel(ch_id)
        if ch:
            asyncio.create_task(ch.send(f"📢 {msg}"))

# ---------------- MIGRATION ANCIENS FICHIERS ----------------
def migrate_old_files():
    os.makedirs(ACCOUNTS_DIR, exist_ok=True)
    for file in os.listdir(ACCOUNTS_DIR):
        if file.endswith(".txt"):
            old_path = f"{ACCOUNTS_DIR}/{file}"
            new_dir = f"{ACCOUNTS_DIR}/free"
            os.makedirs(new_dir, exist_ok=True)
            new_path = f"{new_dir}/{file.lower()}"
            if not os.path.exists(new_path):
                shutil.move(old_path, new_path)
            else:
                # fusionner si déjà existant
                with open(old_path,"r") as f_old, open(new_path,"a") as f_new:
                    f_new.write("\n"+f_old.read())
                os.remove(old_path)

# ---------------- PANEL ----------------
class PanelSelect(Select):
    def __init__(self, author_id):
        options = [
            discord.SelectOption(label="Set Log Channel", description="Change the log channel", emoji="📝"),
            discord.SelectOption(label="Set Free Channel", description="Change the free channel", emoji="📌"),
            discord.SelectOption(label="View Stock", description="Check account stock", emoji="📦"),
        ]
        super().__init__(placeholder="Select an action...", min_values=1, max_values=1, options=options)
        self.author_id = author_id

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.author_id:
            return await interaction.response.send_message("❌ Owner only", ephemeral=True)
        cfg = load_json(CONFIG_FILE)

        if self.values[0] == "Set Log Channel":
            await interaction.response.send_message(f"Current log channel: {cfg.get('log_channel')}\nType the **new channel ID** here.", ephemeral=False)
            def check(m): return m.author.id == self.author_id and m.channel == interaction.channel
            try:
                msg = await bot.wait_for("message", check=check, timeout=60)
                cfg["log_channel"] = int(msg.content.strip())
                save_json(CONFIG_FILE, cfg)
                await interaction.channel.send(f"✅ Log channel updated to <#{cfg['log_channel']}>")
            except asyncio.TimeoutError:
                await interaction.channel.send("❌ Timeout, no channel updated.")

        elif self.values[0] == "Set Free Channel":
            await interaction.response.send_message(f"Current free channel: {cfg.get('free_channel')}\nType the **new channel ID** here.", ephemeral=False)
            def check2(m): return m.author.id == self.author_id and m.channel == interaction.channel
            try:
                msg = await bot.wait_for("message", check=check2, timeout=60)
                cfg["free_channel"] = int(msg.content.strip())
                save_json(CONFIG_FILE, cfg)
                await interaction.channel.send(f"✅ Free channel updated to <#{cfg['free_channel']}>")
            except asyncio.TimeoutError:
                await interaction.channel.send("❌ Timeout, no channel updated.")

        elif self.values[0] == "View Stock":
            msg = "📦 Stock:\n"
            for cat in ["free","premium","paid"]:
                cat_dir = f"{ACCOUNTS_DIR}/{cat}"
                if os.path.exists(cat_dir):
                    for file in os.listdir(cat_dir):
                        if file.endswith(".txt"):
                            with open(f"{cat_dir}/{file}","r") as f:
                                count = len(f.readlines())
                            msg += f"• {cat}/{file.replace('.txt','')}: {count} accounts\n"
            await interaction.response.send_message(msg, ephemeral=True)

class PanelView(View):
    def __init__(self, author_id):
        super().__init__(timeout=None)
        self.add_item(PanelSelect(author_id))

@bot.command()
async def panel(ctx):
    if ctx.author.id not in AUTHORIZED_IDS:
        return await ctx.send("❌ Owner only")
    view = PanelView(ctx.author.id)
    embed = discord.Embed(
        title="🛠 Bot Configuration Panel",
        description="Select an action from the dropdown menu below to configure the bot.",
        color=discord.Color.blurple()
    )
    await ctx.send(embed=embed, view=view)

# ---------------- GEN ----------------
@bot.command()
async def gen(ctx, tier=None, service=None):
    if tier not in ["free","premium","paid"]:
        return
    expected_channel = TICKET_CATEGORY_IDS[tier]
    if ctx.channel.id != expected_channel:
        return
    if not service:
        return await ctx.send("Usage: `!gen <tier> <service>`")

    service = service.lower()
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    if not os.path.exists(path):
        return await ctx.send("❌ Out of stock")
    with open(path, "r") as f:
        accounts = f.read().splitlines()
    if not accounts:
        return await ctx.send("❌ Out of stock")

    acc = accounts.pop(0)
    with open(path, "w") as f:
        f.write("\n".join(accounts))
    save_json(path, accounts)

    # Créer ticket
    category = bot.get_channel(TICKET_CATEGORY_IDS[tier])
    overwrites = {
        ctx.guild.default_role: discord.PermissionOverwrite(read_messages=False),
        ctx.author: discord.PermissionOverwrite(read_messages=True),
        ctx.guild.me: discord.PermissionOverwrite(read_messages=True)
    }
    ticket = await ctx.guild.create_text_channel(f"redeem-{service}", category=category, overwrites=overwrites)
    code = ''.join(random.choices(string.ascii_uppercase, k=4))

    pending = load_json(PENDING_FILE)
    pending[code] = {"account": acc, "user": ctx.author.id, "service": service, "tier":tier}
    save_json(PENDING_FILE, pending)

    embed = discord.Embed(
        title=f"🎫 Ticket {code}",
        description=f"Hello {ctx.author.mention}!\nHere is your **{tier.upper()} {service}** account.",
        color=discord.Color.purple()
    )
    embed.add_field(name="Redeem Code", value=f"`!redeem {code}`", inline=False)
    embed.add_field(name="Instructions", value="Use this code only in this ticket!", inline=False)
    embed.set_thumbnail(url="https://i.imgur.com/DP8lYF2.png")
    embed.set_footer(text="🎉 Enjoy your account!", icon_url="https://i.imgur.com/DP8lYF2.png")
    await ticket.send(embed=embed)
    await ctx.send(f"✅ Ticket created: {ticket.mention}")
    send_log(f"{ctx.author} generated {service} | code {code}")

    stats = load_json(STATS_FILE)
    stats[str(ctx.author.id)] = stats.get(str(ctx.author.id),0)+1
    save_json(STATS_FILE, stats)

# ---------------- REDEEM ----------------
@bot.command()
async def redeem(ctx, code=None):
    if not code: return
    code = code.upper().strip()
    pending = load_json(PENDING_FILE)
    if code not in pending: return await ctx.send("❌ Invalid code")
    data = pending[code]
    try:
        embed = discord.Embed(
            title=f"📨 Your {data['tier'].upper()} {data['service']} account",
            description=f"```\n{data['account']}\n```",
            color=discord.Color.green()
        )
        await ctx.author.send(embed=embed)
        await ctx.send("✅ Account sent in DM. Ticket will close in 5s.")
        del pending[code]
        save_json(PENDING_FILE, pending)
        await asyncio.sleep(5)
        await ctx.channel.delete()
    except:
        await ctx.send("❌ Open your DMs!")

# ---------------- SEND ----------------
@bot.command()
async def send(ctx, member: discord.Member=None, amount: int=None, service=None):
    if ctx.author.id not in AUTHORIZED_IDS:
        return await ctx.send("❌ Owner only")
    if not member or not amount or not service:
        return await ctx.send("❌ Usage: !send @user <amount> <service>")

    service = service.lower()
    found = False
    for tier in ["free","premium","paid"]:
        path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
        if os.path.exists(path):
            found = True
            with open(path,"r") as f:
                accounts = f.read().splitlines()
            to_send = accounts[:amount]
            remaining = accounts[amount:]
            with open(path,"w") as f:
                f.write("\n".join(remaining))
            save_json(path, remaining)
            try:
                await member.send(f"📨 Here are your {amount} {service} accounts:\n```\n{chr(10).join(to_send)}\n```")
                await ctx.send(f"✅ Sent {amount} {service} accounts to {member.mention}")
                send_log(f"{ctx.author} sent {amount} {service} accounts to {member}")
            except:
                await ctx.send("❌ Cannot DM this user!")
            break
    if not found:
        await ctx.send("❌ Service not found")

# ---------------- STOCK ----------------
@bot.command()
async def stock(ctx):
    msg = ""
    for cat in ["free","premium","paid"]:
        cat_dir = f"{ACCOUNTS_DIR}/{cat}"
        if os.path.exists(cat_dir):
            for file in os.listdir(cat_dir):
                if file.endswith(".txt"):
                    with open(f"{cat_dir}/{file}","r") as f:
                        count = len(f.readlines())
                    msg += f"• {cat}/{file.replace('.txt','')}: {count} accounts\n"
    embed = discord.Embed(title="📦 Stock Overview", description=msg, color=discord.Color.gold())
    await ctx.send(embed=embed)

# ---------------- PROFILE ----------------
@bot.command()
async def profile(ctx, member:discord.Member=None):
    if member is None: member = ctx.author
    stats = load_json(STATS_FILE)
    embed = discord.Embed(
        title=f"📊 Profile of {member.name}",
        description=f"Accounts generated: {stats.get(str(member.id),0)}",
        color=discord.Color.blue()
    )
    await ctx.send(embed=embed)

# ---------------- LEADERBOARD ----------------
@bot.command()
async def leaderboard(ctx):
    stats = load_json(STATS_FILE)
    sorted_stats = sorted(stats.items(), key=lambda x:x[1], reverse=True)
    embed = discord.Embed(title="🏆 Leaderboard", color=discord.Color.gold())
    for i,(uid,count) in enumerate(sorted_stats[:10],start=1):
        member = ctx.guild.get_member(int(uid))
        embed.add_field(name=f"{i}. {member.name if member else uid}", value=f"Accounts generated: {count}", inline=False)
    await ctx.send(embed=embed)

# ---------------- STATUS ----------------
@bot.event
async def on_ready():
    migrate_old_files()
    await bot.change_presence(activity=discord.Game(name="🎮 Playing Code"))
    print(f"{bot.user} is online and ready!")

bot.run(os.getenv("TOKEN"))
