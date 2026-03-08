import discord
from discord.ext import commands
from discord.ui import View, Select, Button
import os, json, random, string, asyncio

# ---------------- CONFIG ----------------
AUTHORIZED_IDS = [1112314692258512926,1040256699480686604,1406599824089808967]
CONFIG_FILE = "config.json"
ACCOUNTS_DIR = "accounts"
PENDING_FILE = "pending.json"
STATS_FILE = "stats.json"
TICKET_CATEGORY_ID = 1479080682784555134

# ---------------- DISCORD ----------------
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

# ---------------- HELPERS ----------------
def load_json(path, default={}):
    if not os.path.exists(path):
        with open(path, "w") as f:
            json.dump(default, f, indent=4)
        return default
    with open(path, "r") as f:
        return json.load(f)

def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=4)

def send_log(msg):
    config = load_json(CONFIG_FILE)
    log_channel_id = config.get("log_channel")
    if log_channel_id:
        ch = bot.get_channel(log_channel_id)
        if ch:
            asyncio.create_task(ch.send(msg))

# ---------------- PANEL ----------------
class PanelSelect(Select):
    def __init__(self, author_id):
        options = [
            discord.SelectOption(label="Set Log Channel", description="Change the log channel"),
            discord.SelectOption(label="Set Free Channel", description="Change the free channel"),
            discord.SelectOption(label="View Stock", description="Check account stock"),
        ]
        super().__init__(placeholder="Select an action...", min_values=1, max_values=1, options=options)
        self.author_id = author_id

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.author_id:
            return await interaction.response.send_message("❌ Owner only", ephemeral=True)
        cfg = load_json(CONFIG_FILE)

        if self.values[0] == "Set Log Channel":
            await interaction.response.send_message(f"Current log channel: {cfg.get('log_channel')}\nReply with the new channel ID in chat.", ephemeral=True)
        elif self.values[0] == "Set Free Channel":
            await interaction.response.send_message(f"Current free channel: {cfg.get('free_channel')}\nReply with the new channel ID in chat.", ephemeral=True)
        elif self.values[0] == "View Stock":
            msg = "📦 Stock:\n"
            if os.path.exists(ACCOUNTS_DIR):
                for file in os.listdir(ACCOUNTS_DIR):
                    if file.endswith(".txt"):
                        with open(f"{ACCOUNTS_DIR}/{file}","r") as f:
                            count = len(f.readlines())
                        msg += f"{file.replace('.txt','')}: {count} accounts\n"
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
    await ctx.send("🛠 Bot Configuration Panel", view=view)

# ---------------- GEN ----------------
@bot.command()
async def gen(ctx, tier=None, service=None):
    config = load_json(CONFIG_FILE)
    if ctx.channel.id != config.get("free_channel"):
        return
    if tier != "free" or not service:
        return await ctx.send("Usage: !gen free <service>")

    os.makedirs(ACCOUNTS_DIR, exist_ok=True)
    path = f"{ACCOUNTS_DIR}/{service}.txt"
    if not os.path.exists(path):
        return await ctx.send("❌ Out of stock")
    with open(path, "r") as f:
        accounts = f.read().splitlines()
    if not accounts:
        return await ctx.send("❌ Out of stock")

    acc = accounts.pop(0)
    with open(path, "w") as f:
        f.write("\n".join(accounts))

    pending = load_json(PENDING_FILE)
    code = ''.join(random.choices(string.ascii_uppercase, k=4))
    pending[code] = {"account": acc, "user": ctx.author.id, "service": service}
    save_json(PENDING_FILE, pending)

    category = bot.get_channel(TICKET_CATEGORY_ID)
    overwrites = {
        ctx.guild.default_role: discord.PermissionOverwrite(read_messages=False),
        ctx.author: discord.PermissionOverwrite(read_messages=True),
        ctx.guild.me: discord.PermissionOverwrite(read_messages=True)
    }
    ticket = await ctx.guild.create_text_channel(f"redeem-{code.lower()}", category=category, overwrites=overwrites)
    await ticket.send(f"Use !redeem {code}")
    await ctx.send(f"✅ Ticket created: {ticket.mention}")
    send_log(f"{ctx.author} generated {service} | code {code}")

    stats = load_json(STATS_FILE)
    stats[str(ctx.author.id)] = stats.get(str(ctx.author.id),0)+1
    save_json(STATS_FILE, stats)

# ---------------- REDEEM ----------------
@bot.command()
async def redeem(ctx, code=None):
    if not code:
        return
    code = code.upper().strip()
    pending = load_json(PENDING_FILE)
    if code not in pending:
        return await ctx.send("❌ Invalid code")
    data = pending[code]
    if ctx.author.id != data["user"]:
        return await ctx.send("❌ Not your code")
    try:
        await ctx.author.send(f"{data['service']} account:\n{data['account']}")
        await ctx.send("✅ Account sent in DM. Ticket will close in 5s.")
        del pending[code]
        save_json(PENDING_FILE, pending)
        await asyncio.sleep(5)
        await ctx.channel.delete()
    except:
        await ctx.send("❌ Open your DMs!")

# ---------------- STOCK ----------------
@bot.command()
async def stock(ctx):
    msg = "📦 Current Stock:\n"
    if os.path.exists(ACCOUNTS_DIR):
        for file in os.listdir(ACCOUNTS_DIR):
            if file.endswith(".txt"):
                with open(f"{ACCOUNTS_DIR}/{file}","r") as f:
                    count = len(f.readlines())
                msg += f"{file.replace('.txt','')}: {count} accounts\n"
    await ctx.send(msg)

# ---------------- ADD ----------------
@bot.command()
async def add(ctx, service):
    if ctx.author.id not in AUTHORIZED_IDS:
        return await ctx.send("❌ Owner only")
    if not ctx.message.attachments:
        return await ctx.send("❌ Attach a txt file")
    data = await ctx.message.attachments[0].read()
    new_accounts = data.decode().splitlines()
    os.makedirs(ACCOUNTS_DIR, exist_ok=True)
    path = f"{ACCOUNTS_DIR}/{service}.txt"
    existing = []
    if os.path.exists(path):
        with open(path,"r") as f:
            existing = f.read().splitlines()
    with open(path,"w") as f:
        f.write("\n".join(existing+new_accounts))
    await ctx.send(f"✅ Added {len(new_accounts)} accounts to {service}")
    send_log(f"{ctx.author} added {len(new_accounts)} {service}")

# ---------------- PROFILE ----------------
@bot.command()
async def profile(ctx, member:discord.Member=None):
    if member is None:
        member = ctx.author
    stats = load_json(STATS_FILE)
    await ctx.send(f"{member.name} generated {stats.get(str(member.id),0)} accounts")

# ---------------- LEADERBOARD ----------------
@bot.command()
async def leaderboard(ctx):
    stats = load_json(STATS_FILE)
    sorted_stats = sorted(stats.items(), key=lambda x:x[1], reverse=True)
    msg = "🏆 Leaderboard:\n"
    for i,(uid,count) in enumerate(sorted_stats[:10],start=1):
        member = ctx.guild.get_member(int(uid))
        msg += f"{i}. {member.name if member else uid}: {count} accounts\n"
    await ctx.send(msg)

# ---------------- RUN ----------------
bot.run(os.getenv("TOKEN"))
