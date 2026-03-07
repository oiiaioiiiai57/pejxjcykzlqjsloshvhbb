import discord
from discord.ext import commands
from discord.ui import View
import os
import random
import string
import asyncio

intents = discord.Intents.default()
intents.members = True
intents.message_content = True
intents.presences = True

bot = commands.Bot(command_prefix="!", intents=intents)

# CONFIG
AUTHORIZED_IDS = [
    1112314692258512926,
    1040256699480686604,
    1406599824089808967
]

TICKET_CATEGORY_ID = 1479080682784555134
FREE_CHANNEL_ID = 1479204587104895060
REQUIRED_LINK = "discord.gg/htAuguDyv"

pending_redeems = {}

# -------- BUTTONS --------

class TicketActions(View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Support", style=discord.ButtonStyle.primary)
    async def support(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            f"For help contact <@{AUTHORIZED_IDS[2]}>",
            ephemeral=True
        )

    @discord.ui.button(label="Plans", style=discord.ButtonStyle.success)
    async def plans(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            "✨ Weekly: $5 | Monthly: $15\nContact admin to buy",
            ephemeral=True
        )

    @discord.ui.button(label="Report", style=discord.ButtonStyle.danger)
    async def report(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            "Report the problem to an admin.",
            ephemeral=True
        )

# -------- READY --------

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user}")

# -------- GEN --------

@bot.command()
async def gen(ctx, tier=None, service=None):

    if ctx.channel.id != FREE_CHANNEL_ID:
        return await ctx.send(f"❌ Use this command in <#{FREE_CHANNEL_ID}>")

    if tier != "free" or service is None:
        return await ctx.send("Usage: `!gen free netflix`")

    user = ctx.guild.get_member(ctx.author.id)

    has_link = False

    if user.activities:
        for activity in user.activities:
            if isinstance(activity, discord.CustomActivity):
                if activity.name and REQUIRED_LINK.lower() in activity.name.lower():
                    has_link = True
                    break

    if not has_link:
        embed = discord.Embed(
            title="🚫 Access Denied",
            description=f"Add `{REQUIRED_LINK}` in your custom status",
            color=0xff0000
        )
        return await ctx.send(embed=embed)

    path = f"accounts/{service.lower()}.txt"

    if not os.path.exists(path):
        return await ctx.send("❌ Service not found.")

    with open(path, "r") as f:
        lines = f.readlines()

    if not lines:
        return await ctx.send("❌ Out of stock.")

    acc = lines[0].strip()

    with open(path, "w") as f:
        f.writelines(lines[1:])

    code = ''.join(random.choices(string.ascii_uppercase, k=4))

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

    pending_redeems[code] = {
        "acc": acc,
        "user": ctx.author.id,
        "service": service
    }

    embed = discord.Embed(
        title="🎟 Ticket Created",
        description=f"Use the code below:",
        color=0x2f3136
    )

    embed.add_field(
        name="Code",
        value=f"```\n!redeem {code}\n```",
        inline=False
    )

    await ticket.send(embed=embed, view=TicketActions())
    await ctx.send(f"✅ Ticket created: {ticket.mention}")

# -------- REDEEM --------

@bot.command()
async def redeem(ctx, code=None):

    if not code:
        return await ctx.send("❌ Usage: `!redeem CODE`")

    code = code.upper()

    if code not in pending_redeems:
        return await ctx.send("❌ Invalid code")

    data = pending_redeems[code]

    if ctx.author.id != data["user"]:
        return await ctx.send("❌ This is not your code")

    try:

        await ctx.author.send(
            f"🎁 Your {data['service']} account:\n`{data['acc']}`"
        )

        await ctx.send("✅ Sent in DM. Closing ticket...")

        del pending_redeems[code]

        await asyncio.sleep(5)
        await ctx.channel.delete()

    except:
        await ctx.send("❌ Enable your DMs")

# -------- STOCK --------

@bot.command()
async def stock(ctx):

    if not os.path.exists("accounts"):
        return await ctx.send("❌ No stock folder found")

    embed = discord.Embed(
        title="📦 Current Stock",
        color=0x00ff00
    )

    files = os.listdir("accounts")

    if not files:
        return await ctx.send("❌ No stock available")

    for file in files:

        if file.endswith(".txt"):

            with open(f"accounts/{file}", "r") as f:
                count = len(f.readlines())

            embed.add_field(
                name=file.replace(".txt","").upper(),
                value=f"{count} accounts",
                inline=True
            )

    await ctx.send(embed=embed)

# -------- ADD --------

@bot.command()
async def add(ctx, service: str):

    if ctx.author.id not in AUTHORIZED_IDS:
        return await ctx.send("❌ Owner only command")

    if not ctx.message.attachments:
        return await ctx.send("❌ Attach a .txt file")

    attachment = ctx.message.attachments[0]

    content = await attachment.read()
    accounts = content.decode("utf-8").splitlines()

    os.makedirs("accounts", exist_ok=True)

    with open(f"accounts/{service.lower()}.txt", "a") as f:

        for acc in accounts:
            if acc.strip() != "":
                f.write(acc + "\n")

    await ctx.send(f"✅ Added {len(accounts)} accounts to {service}")

# -------- RUN --------

bot.run(os.getenv("TOKEN"))
