import discord
from discord.ext import commands
import os
import json
import random
import string
import asyncio
import time
from github import Github, GithubException, Auth

# ------------------ CONFIG ------------------
TOKEN = os.getenv("TOKEN")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME = "chevalier577pro/gen-bot"

FREE_CHANNEL    = 1479204587104895060
PREMIUM_CHANNEL = 1479080682616520718
PAID_CHANNEL    = 1479080682616520717
TICKET_CATEGORY = 1479080682784555134
LOG_CHANNEL     = 1479239531499880628

STAFF_ROLE    = 1479080681983316004
HELPER_ROLE   = 1479080681983316008
MODERATOR_ROLES = [
    1479080681983316006,
    1479080681983316007,
    1479080681996030042,
    1479080681996030043
]

# ------------------ COLORS ------------------
# Palette cohérente utilisée dans tous les embeds
C_SUCCESS  = 0x57F287   # vert Discord
C_ERROR    = 0xED4245   # rouge Discord
C_WARN     = 0xFEE75C   # jaune Discord
C_INFO     = 0x5865F2   # bleu/violet Discord (blurple)
C_LOG      = 0x2B2D31   # gris sombre pour les logs
C_FREE     = 0x57F287   # vert  — tier free
C_PREMIUM  = 0xA855F7   # violet — tier premium
C_PAID     = 0xFFD166   # or    — tier paid

TIER_COLOR = {"free": C_FREE, "premium": C_PREMIUM, "paid": C_PAID}
TIER_EMOJI = {"free": "🟢", "premium": "🟣", "paid": "🟡"}

# ------------------ INIT ------------------
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents, case_insensitive=True)
bot.remove_command("help")

github_client = Github(auth=Auth.Token(GITHUB_TOKEN))
repo = github_client.get_repo(REPO_NAME)

ACCOUNTS_DIR    = "accounts"
PENDING_FILE    = "pending.json"
STATS_FILE      = "stats.json"
COOLDOWN_FILE   = "cooldowns.json"
SEND_COOLDOWN_FILE = "send_cooldown.json"

# ------------------ UTILS ------------------
def normalize(service: str) -> str:
    return service.capitalize()

def is_mod(member: discord.Member) -> bool:
    return any(role.id in MODERATOR_ROLES for role in member.roles)

def is_helper(member: discord.Member) -> bool:
    return any(role.id == HELPER_ROLE for role in member.roles)

def github_read(path: str) -> list[str]:
    try:
        file = repo.get_contents(path)
        return [line.strip() for line in file.decoded_content.decode().splitlines() if line.strip()]
    except GithubException as e:
        print(f"Error reading {path}: {e}")
        return []

def github_write(path: str, data: list[str]):
    content = "\n".join(data) + "\n"
    try:
        file = repo.get_contents(path)
        repo.update_file(file.path, "Update stock", content, file.sha)
    except GithubException:
        repo.create_file(path, "Create stock file", content)

def load_json(path: str) -> dict:
    try:
        file = repo.get_contents(path)
        return json.loads(file.decoded_content.decode())
    except (GithubException, json.JSONDecodeError) as e:
        print(f"Error loading {path}: {e}")
        return {}

def save_json(path: str, data: dict):
    content = json.dumps(data, indent=4) + "\n"
    try:
        file = repo.get_contents(path)
        repo.update_file(file.path, "Update JSON", content, file.sha)
    except GithubException:
        repo.create_file(path, "Create JSON file", content)

# ------------------ EMBED HELPERS ------------------
def embed_success(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=f"✅  {title}", description=description, color=C_SUCCESS)
    e.set_footer(text="Gen Bot", icon_url="https://cdn.discordapp.com/emojis/1234567890.png")
    return e

def embed_error(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=f"❌  {title}", description=description, color=C_ERROR)
    e.set_footer(text="Gen Bot")
    return e

def embed_warn(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=f"⚠️  {title}", description=description, color=C_WARN)
    e.set_footer(text="Gen Bot")
    return e

def embed_info(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=f"ℹ️  {title}", description=description, color=C_INFO)
    e.set_footer(text="Gen Bot")
    return e

def embed_log(title: str, description: str = None) -> discord.Embed:
    e = discord.Embed(title=title, description=description, color=C_LOG)
    e.timestamp = discord.utils.utcnow()
    return e

# ------------------ LOG ------------------
async def send_log(guild: discord.Guild, embed: discord.Embed):
    channel = guild.get_channel(LOG_CHANNEL)
    if channel:
        await channel.send(embed=embed)

# ------------------ COOLDOWNS ------------------
def check_cooldown(user_id: int, tier: str) -> tuple[bool, int]:
    data = load_json(COOLDOWN_FILE)
    user_key = str(user_id)
    if user_key not in data:
        data[user_key] = {"free": [], "premium": [], "paid": []}

    limits = {"free": (1, 3600), "premium": (3, 3600), "paid": (10, 3600)}
    if tier not in limits:
        raise ValueError(f"Invalid tier: {tier}")

    max_use, period = limits[tier]
    now = int(time.time())
    uses = [t for t in data[user_key][tier] if now - t < period]

    if len(uses) >= max_use:
        remaining = period - (now - uses[0])
        return False, remaining

    uses.append(now)
    data[user_key][tier] = uses
    save_json(COOLDOWN_FILE, data)
    return True, 0

# ------------------ READY ------------------
@bot.event
async def on_ready():
    print(f"Bot connecté : {bot.user}")
    await bot.change_presence(activity=discord.Game("!help • Gen Bot"))

# ------------------ GEN ------------------
@bot.command()
async def gen(ctx: commands.Context, tier: str = None, service: str = None):
    if tier is None or service is None:
        e = embed_error("Utilisation incorrecte", "**Syntaxe :** `!gen <free|premium|paid> <service>`")
        return await ctx.send(embed=e)

    tier = tier.lower()
    if tier not in ["free", "premium", "paid"]:
        e = embed_error("Tier invalide", "Choisissez parmi : `free` · `premium` · `paid`")
        return await ctx.send(embed=e)

    channels = {"free": FREE_CHANNEL, "premium": PREMIUM_CHANNEL, "paid": PAID_CHANNEL}
    if ctx.channel.id != channels[tier]:
        return

    if not is_mod(ctx.author):
        allowed, remaining = check_cooldown(ctx.author.id, tier)
        if not allowed:
            minutes, seconds = divmod(remaining, 60)
            e = embed_warn(
                "Cooldown actif",
                f"Merci de patienter **{minutes}m {seconds}s** avant de générer à nouveau."
            )
            return await ctx.send(embed=e, delete_after=30)

    service = normalize(service)
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)

    if not stock:
        e = embed_error(
            "Rupture de stock",
            f"Aucun compte **{service}** disponible en tier **{tier}**."
        )
        return await ctx.send(embed=e)

    account = stock.pop(0)
    github_write(path, stock)

    code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    pending = load_json(PENDING_FILE)
    pending[code] = {"account": account, "user": ctx.author.id}
    save_json(PENDING_FILE, pending)

    category = bot.get_channel(TICKET_CATEGORY)
    if not category or not isinstance(category, discord.CategoryChannel):
        e = embed_error("Catégorie introuvable", "La catégorie des tickets est introuvable.")
        return await ctx.send(embed=e)

    overwrites = {
        ctx.guild.default_role: discord.PermissionOverwrite(read_messages=False),
        ctx.author: discord.PermissionOverwrite(read_messages=True, send_messages=True),
        ctx.guild.me: discord.PermissionOverwrite(read_messages=True, send_messages=True)
    }
    ticket_name = f"{service.lower()}-{ctx.author.name.lower()}-{random.randint(1000, 9999)}"
    ticket = await category.create_text_channel(name=ticket_name, overwrites=overwrites)

    # Embed dans le ticket
    tier_color = TIER_COLOR[tier]
    ticket_embed = discord.Embed(
        title="🎟️  Ticket de Génération",
        description=f"Votre compte a été réservé ! Un staff va valider votre ticket.",
        color=tier_color
    )
    ticket_embed.add_field(name="👤 Membre",  value=ctx.author.mention,              inline=True)
    ticket_embed.add_field(name="📦 Service", value=f"**{service}**",                inline=True)
    ticket_embed.add_field(name="🏷️ Tier",   value=f"{TIER_EMOJI[tier]} `{tier.upper()}`", inline=True)
    ticket_embed.add_field(name="🔑 Code de réclamation", value=f"```{code}```",     inline=False)
    ticket_embed.add_field(name="📋 Commande staff",      value=f"`!redeem {code}`", inline=False)
    ticket_embed.set_footer(text=f"Stock restant : {len(stock)} comptes")
    ticket_embed.timestamp = discord.utils.utcnow()
    await ticket.send(f"<@&{STAFF_ROLE}> {ctx.author.mention}", embed=ticket_embed)

    # Confirmation dans le channel gen
    confirm = embed_success(
        "Ticket créé !",
        f"Ton ticket a été ouvert, {ctx.author.mention} !\nUn staff va s'occuper de toi très bientôt."
    )
    confirm.add_field(name="🎫 Ticket", value=ticket.mention, inline=True)
    confirm.add_field(name="📦 Service", value=f"**{service}** ({tier.upper()})", inline=True)
    await ctx.send(embed=confirm)

    # Stats
    stats = load_json(STATS_FILE)
    uid = str(ctx.author.id)
    stats[uid] = stats.get(uid, 0) + 1
    save_json(STATS_FILE, stats)

    # Log
    log = embed_log("📝 Génération", f"{ctx.author.mention} a généré un compte **{service}** ({tier})")
    log.add_field(name="Ticket", value=ticket.mention)
    await send_log(ctx.guild, log)

# ------------------ REDEEM ------------------
@bot.command()
async def redeem(ctx: commands.Context, code: str = None):
    if not (is_helper(ctx.author) or is_mod(ctx.author)):
        return

    if code is None:
        e = embed_error("Utilisation incorrecte", "**Syntaxe :** `!redeem <code>`")
        return await ctx.send(embed=e)

    pending = load_json(PENDING_FILE)
    if code not in pending:
        e = embed_error("Code invalide", "Ce code n'existe pas ou a déjà été utilisé.")
        return await ctx.send(embed=e)

    account = pending[code]["account"]
    user_id = pending[code]["user"]
    user = ctx.guild.get_member(user_id)

    if not user:
        e = embed_error("Membre introuvable", "L'utilisateur n'est plus sur le serveur.")
        return await ctx.send(embed=e)

    # DM embed au membre
    dm_embed = discord.Embed(
        title="📦  Votre compte est prêt !",
        description="Voici votre compte généré. Ne le partagez avec personne !",
        color=C_SUCCESS
    )
    dm_embed.add_field(name="🔐 Identifiants", value=f"```{account}```", inline=False)
    dm_embed.set_footer(text="Gen Bot • Merci de votre confiance !")
    dm_embed.timestamp = discord.utils.utcnow()

    try:
        await user.send(embed=dm_embed)
        confirm = embed_success("Compte envoyé !", f"Les identifiants ont été envoyés en DM à {user.mention}.")
        await ctx.send(embed=confirm)
    except discord.Forbidden:
        e = embed_warn("DMs fermés", f"Impossible d'envoyer un DM à {user.mention}.")
        await ctx.send(embed=e)
    except Exception as ex:
        e = embed_error("Erreur", str(ex))
        await ctx.send(embed=e)

    del pending[code]
    save_json(PENDING_FILE, pending)

    log = embed_log("📝 Réclamation", f"{ctx.author.mention} a validé le ticket de {user.mention}")
    log.add_field(name="Compte", value=f"||`{account}`||")
    await send_log(ctx.guild, log)

    await asyncio.sleep(5)
    await ctx.channel.delete(reason="Ticket réclamé")

# ------------------ STOCK ------------------
async def send_stock(ctx: commands.Context, tier: str):
    tiers = ["free", "premium", "paid"] if tier == "all" else [tier]
    color_map = {"free": C_FREE, "premium": C_PREMIUM, "paid": C_PAID, "all": C_INFO}

    embed = discord.Embed(
        title=f"📦  Stock — {tier.capitalize()}",
        color=color_map.get(tier, C_INFO)
    )

    total = 0
    for t in tiers:
        lines = []
        try:
            files = repo.get_contents(f"{ACCOUNTS_DIR}/{t}")
            if not isinstance(files, list):
                files = [files]
            for f in files:
                service = f.name.replace(".txt", "")
                count = len(github_read(f.path))
                total += count
                bar = "█" * min(count // 10, 10) + "░" * (10 - min(count // 10, 10))
                lines.append(f"`{bar}` **{service}** — {count} comptes")
        except GithubException:
            lines.append("*Aucun stock disponible*")

        embed.add_field(
            name=f"{TIER_EMOJI[t]}  {t.upper()}",
            value="\n".join(lines) if lines else "*Vide*",
            inline=False
        )

    embed.set_footer(text=f"Total : {total} comptes disponibles")
    embed.timestamp = discord.utils.utcnow()
    await ctx.send(embed=embed)

@bot.command()
async def stock(ctx): await send_stock(ctx, "all")

@bot.command(name="stock-free")
async def stock_free(ctx): await send_stock(ctx, "free")

@bot.command(name="stock-premium")
async def stock_premium(ctx): await send_stock(ctx, "premium")

@bot.command(name="stock-paid")
async def stock_paid(ctx): await send_stock(ctx, "paid")

# ------------------ PROFILE ------------------
@bot.command()
async def profile(ctx: commands.Context, member: discord.Member = None):
    member = member or ctx.author
    stats = load_json(STATS_FILE)
    count = stats.get(str(member.id), 0)
    cooldowns = load_json(COOLDOWN_FILE)
    cd = cooldowns.get(str(member.id), {"free": [], "premium": [], "paid": []})

    now = int(time.time())
    free_uses    = len([t for t in cd["free"]    if now - t < 3600])
    premium_uses = len([t for t in cd["premium"] if now - t < 3600])
    paid_uses    = len([t for t in cd["paid"]    if now - t < 3600])

    embed = discord.Embed(
        title="👤  Profil",
        description=f"Statistiques de {member.mention}",
        color=C_INFO
    )
    embed.set_thumbnail(url=member.display_avatar.url)
    embed.add_field(name="🎯 Générations totales", value=f"**{count}**", inline=False)

    def usage_bar(uses, max_uses):
        filled = round((uses / max_uses) * 5)
        return "🟩" * filled + "⬛" * (5 - filled) + f"  `{uses}/{max_uses}`"

    embed.add_field(name="🟢 Free",    value=usage_bar(free_uses, 1),    inline=True)
    embed.add_field(name="🟣 Premium", value=usage_bar(premium_uses, 3), inline=True)
    embed.add_field(name="🟡 Paid",    value=usage_bar(paid_uses, 10),   inline=True)
    embed.set_footer(text="Quota réinitialisé toutes les heures")
    embed.timestamp = discord.utils.utcnow()
    await ctx.send(embed=embed)

# ------------------ LEADERBOARD ------------------
@bot.command()
async def leaderboard(ctx: commands.Context):
    stats = load_json(STATS_FILE)
    sorted_stats = sorted(stats.items(), key=lambda x: int(x[1]), reverse=True)[:10]

    medals = {1: "🥇", 2: "🥈", 3: "🥉"}
    embed = discord.Embed(
        title="🏆  Classement — Top Générateurs",
        color=C_PAID
    )

    if not sorted_stats:
        embed.description = "*Aucune génération pour l'instant.*"
    else:
        lines = []
        for i, (uid, count) in enumerate(sorted_stats, 1):
            user = ctx.guild.get_member(int(uid))
            name = user.display_name if user else f"Utilisateur #{uid}"
            medal = medals.get(i, f"`#{i}`")
            lines.append(f"{medal}  **{name}** — {count} génération{'s' if count > 1 else ''}")
        embed.description = "\n".join(lines)

    embed.set_footer(text=f"Demandé par {ctx.author.display_name}")
    embed.timestamp = discord.utils.utcnow()
    await ctx.send(embed=embed)

# ------------------ ADD ------------------
@bot.command()
async def add(ctx: commands.Context, tier: str = None, service: str = None):
    if not (is_helper(ctx.author) or is_mod(ctx.author)):
        return

    if tier is None or service is None:
        e = embed_error("Utilisation incorrecte", "**Syntaxe :** `!add <free|premium|paid> <service>` + fichier `.txt`")
        return await ctx.send(embed=e)

    tier = tier.lower()
    if tier not in ["free", "premium", "paid"]:
        e = embed_error("Tier invalide", "Choisissez parmi : `free` · `premium` · `paid`")
        return await ctx.send(embed=e)

    if not ctx.message.attachments:
        e = embed_error("Aucun fichier joint", "Veuillez joindre un fichier `.txt` contenant les comptes.")
        return await ctx.send(embed=e)

    attachment = ctx.message.attachments[0]
    if not attachment.filename.endswith(".txt"):
        e = embed_error("Fichier invalide", "Seuls les fichiers `.txt` sont acceptés.")
        return await ctx.send(embed=e)

    try:
        data = await attachment.read()
        lines = [line.decode().strip() for line in data.splitlines() if line.strip()]
    except Exception as ex:
        e = embed_error("Erreur de lecture", str(ex))
        return await ctx.send(embed=e)

    service = normalize(service)
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)
    stock.extend(lines)
    github_write(path, stock)

    e = embed_success(
        "Stock mis à jour !",
        f"**{len(lines)}** comptes ajoutés à `{tier}/{service}`.\nStock total : **{len(stock)}** comptes."
    )
    await ctx.send(embed=e)

    log = embed_log("📝 Ajout de stock", f"{ctx.author.mention} a ajouté **{len(lines)}** comptes → `{tier}/{service}`")
    await send_log(ctx.guild, log)

# ------------------ REMOVE ------------------
@bot.command()
async def remove(ctx: commands.Context, tier: str = None, service: str = None, amount: int = 1):
    if not is_mod(ctx.author):
        return

    if tier is None or service is None or amount < 1:
        e = embed_error("Utilisation incorrecte", "**Syntaxe :** `!remove <free|premium|paid> <service> <montant>`")
        return await ctx.send(embed=e)

    tier = tier.lower()
    if tier not in ["free", "premium", "paid"]:
        e = embed_error("Tier invalide", "Choisissez parmi : `free` · `premium` · `paid`")
        return await ctx.send(embed=e)

    service = normalize(service)
    path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)

    if len(stock) < amount:
        e = embed_warn("Stock insuffisant", f"Seulement **{len(stock)}** comptes disponibles pour `{tier}/{service}`.")
        return await ctx.send(embed=e)

    stock = stock[amount:]
    github_write(path, stock)

    e = embed_success(
        "Stock mis à jour !",
        f"**{amount}** comptes supprimés de `{tier}/{service}`.\nStock restant : **{len(stock)}** comptes."
    )
    await ctx.send(embed=e)

    log = embed_log("📝 Suppression de stock", f"{ctx.author.mention} a retiré **{amount}** comptes de `{tier}/{service}`")
    await send_log(ctx.guild, log)

# ------------------ SEND ------------------
@bot.command()
async def send(ctx: commands.Context, member: discord.Member = None, amount: int = 1, service: str = None):
    if not (is_helper(ctx.author) or is_mod(ctx.author)):
        return

    if member is None or service is None or amount < 1:
        e = embed_error("Utilisation incorrecte", "**Syntaxe :** `!send <@membre> <montant> <service>`")
        return await ctx.send(embed=e)

    if not is_mod(ctx.author):
        data = load_json(SEND_COOLDOWN_FILE)
        now = int(time.time())
        user_key = str(ctx.author.id)
        uses = [t for t in data.get(user_key, []) if now - t < 3600]
        if len(uses) >= 5:
            e = embed_warn("Limite atteinte", "Vous pouvez envoyer seulement **5 fois** par heure.")
            return await ctx.send(embed=e)
        uses.append(now)
        data[user_key] = uses
        save_json(SEND_COOLDOWN_FILE, data)

    service = normalize(service)
    sent = False

    for tier in ["free", "premium", "paid"]:
        path = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
        stock = github_read(path)
        if len(stock) >= amount:
            send_accounts = stock[:amount]
            stock = stock[amount:]
            github_write(path, stock)

            # Découpage en chunks pour éviter la limite 2000 chars Discord
            CHUNK_SIZE = 10
            try:
                for i in range(0, len(send_accounts), CHUNK_SIZE):
                    chunk = send_accounts[i:i + CHUNK_SIZE]
                    dm_embed = discord.Embed(
                        title=f"📦  Comptes **{service}** ({tier.upper()})",
                        description=f"```\n" + "\n".join(chunk) + "\n```",
                        color=TIER_COLOR[tier]
                    )
                    dm_embed.set_footer(text=f"Envoyé par {ctx.author.display_name} • Gen Bot")
                    dm_embed.timestamp = discord.utils.utcnow()
                    await member.send(embed=dm_embed)

                e = embed_success(
                    "Comptes envoyés !",
                    f"**{amount}** compte(s) **{service}** envoyé(s) en DM à {member.mention}."
                )
                await ctx.send(embed=e)
                sent = True
            except discord.Forbidden:
                e = embed_warn("DMs fermés", f"Impossible d'envoyer un DM à {member.mention}.")
                await ctx.send(embed=e)
            except Exception as ex:
                e = embed_error("Erreur", str(ex))
                await ctx.send(embed=e)
            break

    if not sent:
        e = embed_error("Stock insuffisant", f"Pas assez de comptes **{service}** dans aucun tier.")
        await ctx.send(embed=e)
    else:
        log = embed_log("📝 Envoi direct", f"{ctx.author.mention} a envoyé **{amount}** `{service}` à {member.mention}")
        await send_log(ctx.guild, log)

# ------------------ HELP ------------------
@bot.command()
async def help(ctx: commands.Context):
    embed = discord.Embed(
        title="📜  Commandes — Gen Bot",
        description="Préfixe : `!`",
        color=C_INFO
    )

    embed.add_field(
        name="👥  Membres",
        value=(
            "`!gen <tier> <service>` — Générer un compte\n"
            "`!profile [@user]` — Voir les stats d'un profil\n"
            "`!leaderboard` — Top 10 des générateurs\n"
            "`!stock` — Voir tout le stock\n"
            "`!stock-free` · `!stock-premium` · `!stock-paid` — Stock par tier"
        ),
        inline=False
    )
    embed.add_field(
        name="🛡️  Staff",
        value=(
            "`!redeem <code>` — Valider un ticket\n"
            "`!add <tier> <service>` — Ajouter des comptes (fichier `.txt`)\n"
            "`!send <@user> <montant> <service>` — Envoyer des comptes en DM\n"
            "`!remove <tier> <service> <montant>` — Supprimer du stock"
        ),
        inline=False
    )
    embed.add_field(
        name="🏷️  Tiers disponibles",
        value="🟢 `free` · 🟣 `premium` · 🟡 `paid`",
        inline=False
    )
    embed.set_footer(text="Gen Bot • Besoin d'aide ? Contactez un staff.")
    embed.timestamp = discord.utils.utcnow()
    await ctx.send(embed=embed)

# ------------------ ERROR HANDLER ------------------
@bot.event
async def on_command_error(ctx: commands.Context, error: commands.CommandError):
    if isinstance(error, commands.CommandNotFound):
        return
    e = embed_error("Une erreur est survenue", str(error))
    await ctx.send(embed=e)
    raise error

bot.run(TOKEN)
