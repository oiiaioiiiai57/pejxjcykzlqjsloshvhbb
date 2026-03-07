import discord
from discord.ext import commands
from discord.ui import Button, View
import os
import random
import string
import asyncio

intents = discord.Intents.default()
intents.members = True
intents.message_content = True
intents.presences = True

bot = commands.Bot(command_prefix="!", intents=intents)

# --- CONFIGURATION ---
OWNER_ID = 1406599824089808967
TICKET_CATEGORY_ID = 1479080682784555131
FREE_CHANNEL_ID = 1479204587104895060
ADMIN_ROLE_NAME = "Admin"
REQUIRED_LINK = "discord.gg/htAuguDyv"

pending_redeems = {}

class TicketActions(View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Support", style=discord.ButtonStyle.primary)
    async def support(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            f"For help, contact <@{OWNER_ID}>",
            ephemeral=True
        )

    @discord.ui.button(label="Plans", style=discord.ButtonStyle.success)
    async def plans(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            "✨ **Weekly:** $5 | **Monthly:** $15\nContact Admin to buy!",
            ephemeral=True
        )

    @discord.ui.button(label="Report", style=discord.ButtonStyle.danger)
    async def report(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            "📝 Tell the Admin about the issue with your account.",
            ephemeral=True
        )


@bot.event
async def on_ready():
    print(f"Logged in as: {bot.user}")


@bot.command()
async def gen(ctx, tier=None, service=None):

    if ctx.channel.id != FREE_CHANNEL_ID:
        return await ctx.send(f"❌ Go to <#{FREE_CHANNEL_ID}> channel!")

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
            description=f"You must add `{REQUIRED_LINK}` to your **Custom Status** to use the Free Generator!",
            color=0xff0000
        )
        return await ctx.send(embed=embed)

    path = f"accounts/{service.lower()}.txt"

    if os.path.exists(path) and os.path.getsize(path) > 0:

        with open(path, "r") as f:
            lines = f.readlines()

        acc = lines[0].strip()

        category = bot.get_channel(TICKET_CATEGORY_ID)

        try:

            code = ''.join(random.choices(string.ascii_uppercase, k=4))

            overwrites = {
                ctx.guild.default_role: discord.PermissionOverwrite(read_messages=False),
                ctx.author: discord.PermissionOverwrite(read_messages=True, send_messages=True),
                ctx.guild.me: discord.PermissionOverwrite(read_messages=True, send_messages=True)
            }

            ticket = await ctx.guild.create_text_channel(
                name=f"redeem-{code.lower()}",
                category=category if isinstance(category, discord.CategoryChannel) else None,
                overwrites=overwrites
            )

            with open(path, "w") as f:
                f.writelines(lines[1:])

            pending_redeems[code] = {
                "acc": acc,
                "user": ctx.author.id,
                "service": service
            }

            embed = discord.Embed(
                title="🎟️ Ticket Generated!",
                description=f"Hello {ctx.author.mention}, Bio Verified!",
                color=0x2f3136
            )

            embed.add_field(
                name="🔑 Your Code",
                value=f"```\n!redeem {code}\n```",
                inline=False
            )

            await ticket.send(embed=embed, view=TicketActions())

            await ctx.send(f"✅ Ticket created: {ticket.mention}")

        except Exception as e:
            await ctx.send(f"❌ Error: {e}")

    else:
        await ctx.send("❌ Out of stock.")


@bot.command()
async def redeem(ctx, code: str = None):

    if code is None:
        return await ctx.send("❌ Usage: `!redeem CODE`")

    code = code.upper().strip()

    if code in pending_redeems:

        data = pending_redeems[code]

        if ctx.author.id != data["user"]:
            return await ctx.send("❌ Not yours!")

        try:

            await ctx.author.send(
                f"🎁 Your {data['service'].upper()} account: `{data['acc']}`"
            )

            await ctx.send("✅ Sent to DM! Ticket closing in 5s.")

            del pending_redeems[code]

            await asyncio.sleep(5)

            await ctx.channel.delete()

        except:
            await ctx.send("❌ Open your DMs!")

    else:
        await ctx.send("❌ Invalid Code.")


@bot.command()
async def stock(ctx):

    embed = discord.Embed(title="📦 Current Stock", color=0x00ff00)

    if not os.path.exists('accounts') or not os.listdir('accounts'):
        return await ctx.send("❌ No stock.")

    for file in os.listdir('accounts'):

        if file.endswith(".txt"):

            with open(f"accounts/{file}", "r") as f:
                count = len(f.readlines())

            embed.add_field(
                name=file.replace(".txt", "").upper(),
                value=f"`{count}` accounts",
                inline=True
            )

    await ctx.send(embed=embed)


@bot.command()
async def add(ctx, service: str):

    if ctx.author.id != OWNER_ID:
        return

    if not ctx.message.attachments:
        return await ctx.send("❌ Attach .txt!")

    content = await ctx.message.attachments[0].read()

    accs = content.decode("utf-8").splitlines()

    os.makedirs('accounts', exist_ok=True)

    with open(f"accounts/{service.lower()}.txt", "a") as f:

        for a in accs:
            f.write(f"{a}\n")

    await ctx.send(f"✅ Added {len(accs)} accounts.")


bot.run(os.getenv("TOKEN"))
