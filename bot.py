import discord
from discord import app_commands
from discord.ext import commands
import os, json, random, string, asyncio, time
from github import Github, GithubException, Auth

TOKEN     = os.getenv("TOKEN")
REPO_NAME = "chevalier577pro/pejxjcykzlqjsloshvhbb"

# ── CONFIG MULTI-SERVEUR ──────────────────────────────────────
GUILDS_CONFIG = {
    1479080681572274320: {
        "name":             "Serveur 1",
        "free_channel":     1479204587104895060,
        "premium_channel":  1479080682616520718,
        "paid_channel":     1479080682616520717,
        "ticket_category":  1479080682784555134,
        "log_channel":      1479239531499880628,
        "staff_role":       1479080681983316004,
        "helper_role":      1479080681983316008,
        "addv_role":        1479080681996030042,
        "moderator_roles":  [1479080681983316006,1479080681983316007,1479080681996030042,1479080681996030043],
        "vouch_tiers": [
            (40,  [1479080681983316005, 1479080681983316008]),
            (60,  [1479080681983316006]),
            (100, [1479080681983316007]),
        ],
        "tier_roles": {
            "free":    [1479080681970729122, 1479080681983316001],
            "premium": [1479080681983316003],
            "paid":    [1479080681983316002, 1479080681983316007],
        },
    },
    1479133088524009514: {
        "name":             "Serveur 2",
        "free_channel":     1482070977222410260,
        "premium_channel":  1482070967923773583,
        "paid_channel":     1482070966354972682,
        "ticket_category":  1482070942766071888,
        "log_channel":      1482070978938015867,
        "staff_role":       1482070883525722123,
        "helper_role":      1482070883525722123,
        "addv_role":        1482070883525722123,
        "moderator_roles":  [1482070883525722123],
        "vouch_tiers": [
            (40,  [1482070899023806574]),
            (60,  [1482070887497863228]),
            (100, [1482070888479326219]),
        ],
        "tier_roles": {
            "free":    [1482070899023806574, 1482070889121054892],
            "premium": [1482070887497863228],
            "paid":    [1482070888479326219],
        },
    },
}

def get_guild_cfg(guild_id):
    return GUILDS_CONFIG.get(guild_id)

BACKEND_URL = os.getenv("BACKEND_URL", "https://pejxjcykzlqjsloshvhbb-production.up.railway.app")
BOT_SECRET  = os.getenv("BOT_SECRET", "genbotinternal")

C_SUCCESS=0x57F287; C_ERROR=0xED4245; C_WARN=0xFEE75C; C_INFO=0x5865F2
C_LOG=0x2B2D31; C_FREE=0x57F287; C_PREMIUM=0xA855F7; C_PAID=0xFFD166
TIER_COLOR={"free":C_FREE,"premium":C_PREMIUM,"paid":C_PAID}
TIER_EMOJI={"free":"🟢","premium":"🟣","paid":"🟡"}

intents = discord.Intents.all()
bot  = commands.Bot(command_prefix="$$$_unused", intents=intents)
tree = bot.tree

_gc=None; _ro=None
_WEB_TICKETS_BY_CHANNEL = {}  # { ticket_id: {"channel_id": str} }

def get_repo():
    global _gc,_ro
    if _ro is None:
        t=os.getenv("GITHUB_TOKEN")
        if not t: raise RuntimeError("GITHUB_TOKEN not set")
        _gc=Github(auth=Auth.Token(t)); _ro=_gc.get_repo(REPO_NAME)
    return _ro

repo=type('R',(),{
    'get_contents':lambda s,*a,**kw:get_repo().get_contents(*a,**kw),
    'update_file': lambda s,*a,**kw:get_repo().update_file(*a,**kw),
    'create_file': lambda s,*a,**kw:get_repo().create_file(*a,**kw),
})()

ACCOUNTS_DIR="accounts"; PENDING_FILE="pending.json"; STATS_FILE="stats.json"
COOLDOWN_FILE="cooldowns.json"; SEND_COOLDOWN_FILE="send_cooldown.json"; VOUCHES_FILE="vouches.json"

def normalize(s): return s.capitalize()

def is_mod(m):
    cfg = get_guild_cfg(m.guild.id)
    if not cfg: return False
    return any(r.id in cfg["moderator_roles"] for r in m.roles)

def is_helper(m):
    cfg = get_guild_cfg(m.guild.id)
    if not cfg: return False
    return any(r.id == cfg["helper_role"] for r in m.roles)

def has_addv(m):
    cfg = get_guild_cfg(m.guild.id)
    if not cfg: return False
    return any(r.id == cfg["addv_role"] for r in m.roles)

def github_read(path):
    try:
        f=repo.get_contents(path)
        return [l.strip() for l in f.decoded_content.decode().splitlines() if l.strip()]
    except GithubException: return []

def github_write(path,data):
    content="\n".join(data)+"\n"
    try:
        f=repo.get_contents(path); repo.update_file(f.path,"Update stock",content,f.sha)
    except GithubException: repo.create_file(path,"Create stock",content)

def load_json(path):
    try:
        f=repo.get_contents(path); return json.loads(f.decoded_content.decode())
    except: return {}

def save_json(path,data):
    content=json.dumps(data,indent=4)+"\n"
    try:
        f=repo.get_contents(path); repo.update_file(f.path,"Update JSON",content,f.sha)
    except GithubException: repo.create_file(path,"Create JSON",content)

def embed_success(t,d=None): e=discord.Embed(title=f"✅  {t}",description=d,color=C_SUCCESS); e.set_footer(text="Gen Bot"); return e
def embed_error(t,d=None):   e=discord.Embed(title=f"❌  {t}",description=d,color=C_ERROR);   e.set_footer(text="Gen Bot"); return e
def embed_warn(t,d=None):    e=discord.Embed(title=f"⚠️  {t}",description=d,color=C_WARN);    e.set_footer(text="Gen Bot"); return e
def embed_log(t,d=None):
    e=discord.Embed(title=t,description=d,color=C_LOG); e.timestamp=discord.utils.utcnow(); return e

async def send_log(guild, embed):
    cfg = get_guild_cfg(guild.id)
    if not cfg: return
    ch = guild.get_channel(cfg["log_channel"])
    if ch: await ch.send(embed=embed)

def check_cooldown(user_id,tier):
    data=load_json(COOLDOWN_FILE); key=str(user_id)
    if key not in data: data[key]={"free":[],"premium":[],"paid":[]}
    limits={"free":(1,3600),"premium":(3,3600),"paid":(10,3600)}
    max_u,period=limits[tier]; now=int(time.time())
    uses=[t for t in data[key][tier] if now-t<period]
    if len(uses)>=max_u: return False,period-(now-uses[0])
    uses.append(now); data[key][tier]=uses; save_json(COOLDOWN_FILE,data)
    return True,0

def get_vouches(uid): return load_json(VOUCHES_FILE).get(str(uid),0)

def add_vouch(uid,amount=1):
    data=load_json(VOUCHES_FILE); k=str(uid)
    data[k]=data.get(k,0)+amount; save_json(VOUCHES_FILE,data); return data[k]

async def check_and_promote(guild, member, vouches):
    cfg = get_guild_cfg(guild.id)
    if not cfg: return
    for threshold, role_ids in cfg["vouch_tiers"]:
        if vouches >= threshold:
            newly = []
            for rid in role_ids:
                role = guild.get_role(rid)
                if role and role not in member.roles:
                    await member.add_roles(role, reason=f"Reached {threshold} vouches")
                    newly.append(rid)
            if newly:
                mentions = " ".join(f"<@&{r}>" for r in newly)
                log = embed_log("🎉  Promotion", f"{member.mention} → {mentions} avec **{vouches} vouches**!")
                log.color = C_PREMIUM
                await send_log(guild, log)

def record_gen(uid_str, tier):
    stats=load_json(STATS_FILE)
    stats[uid_str]=stats.get(uid_str,0)+1
    tier_key=uid_str+"_tiers"
    td=stats.get(tier_key,{"free":0,"premium":0,"paid":0})
    td[tier]=td.get(tier,0)+1
    stats[tier_key]=td
    save_json(STATS_FILE,stats)

# ── READY ──────────────────────────────────────────
@bot.event
async def on_ready():
    await tree.sync()
    print(f"Bot online: {bot.user}")
    await bot.change_presence(activity=discord.Game("/help • Gen Bot"))
    try:
        import requests as _req
        r = _req.get(f"{BACKEND_URL}/internal/tickets_map",
                     headers={"X-Bot-Secret": BOT_SECRET}, timeout=5)
        if r.ok:
            data = r.json()
            for tid, ch_id in data.items():
                _WEB_TICKETS_BY_CHANNEL[tid] = {"channel_id": str(ch_id)}
            print(f"✅ Restored {len(data)} web ticket mappings")
    except Exception as e:
        print(f"⚠️ Could not restore ticket mappings: {e}")

# ── ON MESSAGE (bridge Discord → site) ──────────────────────
@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
    ch_id = str(message.channel.id)

    ticket_id = None
    for tid, t in list(_WEB_TICKETS_BY_CHANNEL.items()):
        if t["channel_id"] == ch_id:
            ticket_id = tid
            break

    if not ticket_id:
        try:
            import requests as _req
            r = _req.get(f"{BACKEND_URL}/internal/tickets_map",
                         headers={"X-Bot-Secret": BOT_SECRET}, timeout=3)
            if r.ok:
                for tid, ch in r.json().items():
                    _WEB_TICKETS_BY_CHANNEL[tid] = {"channel_id": str(ch)}
                    if str(ch) == ch_id:
                        ticket_id = tid
        except Exception as e:
            print(f"tickets_map fallback error: {e}")

    if ticket_id:
        import aiohttp
        try:
            async with aiohttp.ClientSession() as sess:
                await sess.post(
                    f"{BACKEND_URL}/internal/ticket/{ticket_id}/message",
                    json={"content": message.content, "author": message.author.display_name},
                    headers={"X-Bot-Secret": BOT_SECRET},
                )
        except Exception as e:
            print(f"Bridge msg error: {e}")

    await bot.process_commands(message)

TIER_CHOICES=[
    app_commands.Choice(name="🟢 Free",    value="free"),
    app_commands.Choice(name="🟣 Premium", value="premium"),
    app_commands.Choice(name="🟡 Paid",    value="paid"),
]

# ── /gen ──────────────────────────────────────────
@tree.command(name="gen",description="Generate an account")
@app_commands.describe(tier="Account tier",service="Service name (e.g. Netflix)")
@app_commands.choices(tier=TIER_CHOICES)
async def gen(interaction:discord.Interaction,tier:app_commands.Choice[str],service:str):
    await interaction.response.defer()
    cfg = get_guild_cfg(interaction.guild_id)
    if not cfg:
        return await interaction.followup.send(embed=embed_error("Serveur non configuré","Ce serveur n'est pas supporté."))

    t=tier.value
    channels={"free":cfg["free_channel"],"premium":cfg["premium_channel"],"paid":cfg["paid_channel"]}
    if channels[t] and interaction.channel_id != channels[t]:
        return await interaction.followup.send(embed=embed_error("Wrong Channel",f"Please use the correct channel for **{t}**."))

    member=interaction.guild.get_member(interaction.user.id)
    if not is_mod(member):
        ok,rem=check_cooldown(interaction.user.id,t)
        if not ok:
            m,s=divmod(rem,60)
            return await interaction.followup.send(embed=embed_warn("Cooldown",f"Wait **{m}m {s}s** before generating again."))

    service=normalize(service)
    path=f"{ACCOUNTS_DIR}/{t}/{service}.txt"
    stock=github_read(path)
    if not stock:
        return await interaction.followup.send(embed=embed_error("Out of Stock",f"No **{service}** accounts in **{t}**."))

    account=stock.pop(0); github_write(path,stock)
    code=''.join(random.choices(string.ascii_uppercase+string.digits,k=6))
    pending=load_json(PENDING_FILE)
    pending[code]={"account":account,"user":interaction.user.id,"tier":t,"service":service}
    save_json(PENDING_FILE,pending)

    category=bot.get_channel(cfg["ticket_category"])
    if not category or not isinstance(category,discord.CategoryChannel):
        return await interaction.followup.send(embed=embed_error("Error","Ticket category not found."))

    overwrites={
        interaction.guild.default_role:discord.PermissionOverwrite(read_messages=False),
        interaction.user:discord.PermissionOverwrite(read_messages=True,send_messages=True),
        interaction.guild.me:discord.PermissionOverwrite(read_messages=True,send_messages=True),
    }
    tname=f"{service.lower()}-{interaction.user.name.lower()}-{random.randint(1000,9999)}"
    ticket=await category.create_text_channel(name=tname,overwrites=overwrites)

    te=discord.Embed(title="🎟️  Generation Ticket",description="Your account has been reserved! Staff will validate shortly.",color=TIER_COLOR[t])
    te.add_field(name="👤 Member",  value=interaction.user.mention,inline=True)
    te.add_field(name="📦 Service", value=f"**{service}**",         inline=True)
    te.add_field(name="🏷️ Tier",   value=f"{TIER_EMOJI[t]} `{t.upper()}`",inline=True)
    te.add_field(name="🔑 Code",    value=f"```{code}```",           inline=False)
    te.add_field(name="📋 Staff",   value=f"`/redeem {code}`",       inline=False)
    te.set_footer(text=f"Remaining stock: {len(stock)}")
    te.timestamp=discord.utils.utcnow()
    await ticket.send(f"<@&{cfg['staff_role']}>",embed=te)

    confirm=embed_success("Ticket Created!",f"Your ticket {ticket.mention} has been opened!\nStaff will assist you shortly.")
    confirm.add_field(name="📦 Service",value=f"**{service}** ({t.upper()})",inline=True)
    await interaction.followup.send(embed=confirm)

    record_gen(str(interaction.user.id),t)
    log=embed_log("📝 Generation",f"{interaction.user.mention} generated **{service}** ({t})")
    log.add_field(name="Ticket",value=ticket.mention)
    await send_log(interaction.guild,log)

# ── /redeem ──────────────────────────────────────────
@tree.command(name="redeem",description="[Staff] Validate a generation ticket")
@app_commands.describe(code="The claim code from the ticket")
async def redeem(interaction:discord.Interaction,code:str):
    await interaction.response.defer()
    member=interaction.guild.get_member(interaction.user.id)
    if not (is_helper(member) or is_mod(member)):
        return await interaction.followup.send(embed=embed_error("Access Denied","No permission."))

    pending=load_json(PENDING_FILE)
    if code not in pending:
        return await interaction.followup.send(embed=embed_error("Invalid Code","Code doesn't exist or already used."))

    entry=pending[code]; account=entry["account"]; user_id=entry["user"]
    web_ticket=entry.get("web_ticket_id")
    user=interaction.guild.get_member(user_id)
    if not user:
        return await interaction.followup.send(embed=embed_error("Member Not Found","User left the server."))

    dm=discord.Embed(title="📦  Your Account is Ready!",description="Do not share with anyone!",color=C_SUCCESS)
    dm.add_field(name="🔐 Credentials",value=f"```{account}```",inline=False)
    dm.set_footer(text="Gen Bot"); dm.timestamp=discord.utils.utcnow()

    try:
        await user.send(embed=dm)
        await interaction.followup.send(embed=embed_success("Sent!",f"Credentials sent via DM to {user.mention}."))
    except discord.Forbidden:
        await interaction.followup.send(embed=embed_warn("DMs Closed",f"Could not DM {user.mention}."))

    del pending[code]; save_json(PENDING_FILE,pending)

    if web_ticket and interaction.channel:
        _WEB_TICKETS_BY_CHANNEL[web_ticket] = {"channel_id": str(interaction.channel.id)}

    if web_ticket:
        import aiohttp
        backend=os.getenv("BACKEND_URL","https://pejxjcykzlqjsloshvhbb-production.up.railway.app")
        try:
            async with aiohttp.ClientSession() as sess:
                await sess.post(f"{backend}/internal/ticket/{web_ticket}/redeem",
                    json={"account":account},
                    headers={"X-Bot-Secret":os.getenv("BOT_SECRET","genbotinternal")})
        except Exception as e:
            print(f"Web ticket notify failed: {e}")

    new_vouches=add_vouch(interaction.user.id)
    await check_and_promote(interaction.guild,member,new_vouches)

    log=embed_log("📝 Redeem",f"{interaction.user.mention} validated ticket for {user.mention}")
    log.add_field(name="Account",value=f"||`{account}`||")
    log.add_field(name="Staff Vouches",value=f"**{new_vouches}**")
    if web_ticket: log.add_field(name="Source",value="🌐 Web")
    await send_log(interaction.guild,log)

    if not web_ticket:
        await asyncio.sleep(5)
        if interaction.channel: await interaction.channel.delete(reason="Ticket redeemed")
    else:
        if interaction.channel:
            await interaction.channel.send(embed=discord.Embed(
                title="✅ Compte validé",
                description=f"Le compte a été envoyé à **{interaction.user.display_name}** via le site web.",
                color=0x57F287
            ))

# ── /close ──────────────────────────────────────────
@tree.command(name="close",description="[Staff] Fermer un ticket")
async def close(interaction:discord.Interaction):
    await interaction.response.defer()
    member=interaction.guild.get_member(interaction.user.id)
    if not (is_helper(member) or is_mod(member)):
        return await interaction.followup.send(embed=embed_error("Access Denied","No permission."))

    ch = interaction.channel
    ticket_id = None
    for tid, t in list(_WEB_TICKETS_BY_CHANNEL.items()):
        if t["channel_id"] == str(ch.id):
            ticket_id = tid
            break

    if ticket_id:
        import aiohttp
        try:
            async with aiohttp.ClientSession() as sess:
                await sess.post(f"{BACKEND_URL}/internal/ticket/{ticket_id}/close",
                    headers={"X-Bot-Secret": BOT_SECRET})
        except Exception as e:
            print(f"Close notify error: {e}")
        _WEB_TICKETS_BY_CHANNEL.pop(ticket_id, None)

    close_embed = embed_log("🔒 Ticket fermé", f"Fermé par {interaction.user.mention}")
    close_embed.color = 0xED4245
    await interaction.followup.send(embed=close_embed)
    await asyncio.sleep(5)
    try:
        await ch.delete(reason=f"Ticket closed by {interaction.user}")
    except Exception as e:
        print(f"Delete channel error: {e}")

# ── /addv ──────────────────────────────────────────
@tree.command(name="addv",description="[Admin] Manually add vouches to a member")
@app_commands.describe(member="Target member",amount="Number of vouches")
async def addv(interaction:discord.Interaction,member:discord.Member,amount:int):
    await interaction.response.defer()
    invoker=interaction.guild.get_member(interaction.user.id)
    if not has_addv(invoker):
        return await interaction.followup.send(embed=embed_error("Access Denied","No permission."))
    if amount<1:
        return await interaction.followup.send(embed=embed_error("Invalid","Amount must be ≥ 1."))
    new_v=add_vouch(member.id,amount)
    await check_and_promote(interaction.guild,member,new_v)
    await interaction.followup.send(embed=embed_success("Vouches Added!",f"Added **{amount}** to {member.mention}. Total: **{new_v}**."))
    log=embed_log("📝 Vouches Added",f"{interaction.user.mention} +{amount} → {member.mention}")
    log.add_field(name="New Total",value=f"**{new_v}**"); await send_log(interaction.guild,log)

# ── /promote ──────────────────────────────────────────
@tree.command(name="promote",description="View vouch progress toward next rank")
@app_commands.describe(member="Member to check (empty = yourself)")
async def promote(interaction:discord.Interaction,member:discord.Member=None):
    await interaction.response.defer()
    cfg = get_guild_cfg(interaction.guild_id)
    target=member or interaction.user; vouches=get_vouches(target.id)
    next_t = None
    if cfg:
        for t, r in cfg["vouch_tiers"]:
            if vouches < t:
                next_t = (t, r)
                break
    embed=discord.Embed(title="🏅  Vouch Progress",description=f"Stats for {target.mention}",color=C_INFO)
    embed.set_thumbnail(url=target.display_avatar.url)
    embed.add_field(name="⭐ Total Vouches",value=f"**{vouches}**",inline=True)
    if next_t:
        threshold,role_ids=next_t; needed=threshold-vouches
        filled=round(min(vouches/threshold,1.0)*10)
        bar="█"*filled+"░"*(10-filled)
        embed.add_field(name="🎯 Next Milestone",value=f"**{threshold}** → {' · '.join(f'<@&{r}>' for r in role_ids)}",inline=True)
        embed.add_field(name="📊 Progress",value=f"`{bar}` {vouches}/{threshold}  (**{needed}** left)",inline=False)
    else:
        embed.add_field(name="🏆",value="Maximum rank reached!",inline=False)
    if cfg:
        lines=[f"{'✅' if vouches>=t else '🔒'} **{t} vouches** → {' · '.join(f'<@&{r}>' for r in rs)}" for t,rs in cfg["vouch_tiers"]]
        embed.add_field(name="📋 All Milestones",value="\n".join(lines),inline=False)
    embed.set_footer(text="Vouches earned by redeeming tickets"); embed.timestamp=discord.utils.utcnow()
    await interaction.followup.send(embed=embed)

# ── /stock ──────────────────────────────────────────
async def _build_stock_embed(tier):
    tiers=["free","premium","paid"] if tier=="all" else [tier]
    color_map={"free":C_FREE,"premium":C_PREMIUM,"paid":C_PAID,"all":C_INFO}
    embed=discord.Embed(title=f"📦  Stock — {tier.capitalize()}",color=color_map.get(tier,C_INFO))
    total=0
    for t in tiers:
        lines=[]
        try:
            files=repo.get_contents(f"{ACCOUNTS_DIR}/{t}")
            if not isinstance(files,list): files=[files]
            for f in files:
                svc=f.name.replace(".txt",""); count=len(github_read(f.path)); total+=count
                filled=min(count//10,10); bar="█"*filled+"░"*(10-filled)
                lines.append(f"`{bar}` **{svc}** — {count}")
        except GithubException: lines.append("*No stock*")
        embed.add_field(name=f"{TIER_EMOJI[t]}  {t.upper()}",value="\n".join(lines) or "*Empty*",inline=False)
    embed.set_footer(text=f"Total: {total} accounts"); embed.timestamp=discord.utils.utcnow()
    return embed

@tree.command(name="stock",description="View available stock")
@app_commands.choices(tier=TIER_CHOICES)
async def stock(interaction:discord.Interaction,tier:app_commands.Choice[str]=None):
    await interaction.response.defer()
    embed=await _build_stock_embed(tier.value if tier else "all")
    await interaction.followup.send(embed=embed)

# ── /profile ──────────────────────────────────────────
@tree.command(name="profile",description="View a member's profile & stats")
@app_commands.describe(member="Member to view (empty = yourself)")
async def profile(interaction:discord.Interaction,member:discord.Member=None):
    await interaction.response.defer()
    target=member or interaction.user; uid=str(target.id)
    stats=load_json(STATS_FILE)
    total_gens=stats.get(uid,0) if isinstance(stats.get(uid),int) else 0
    td=stats.get(uid+"_tiers",{"free":0,"premium":0,"paid":0})
    free_g=td.get("free",0); prem_g=td.get("premium",0); paid_g=td.get("paid",0)
    cd=load_json(COOLDOWN_FILE).get(uid,{"free":[],"premium":[],"paid":[]})
    vouches=get_vouches(target.id); now=int(time.time())
    fu=len([t for t in cd.get("free",[])    if now-t<3600])
    pu=len([t for t in cd.get("premium",[]) if now-t<3600])
    du=len([t for t in cd.get("paid",[])    if now-t<3600])
    def bar(uses,max_u):
        filled=round((uses/max_u)*5)
        return "🟩"*filled+"⬛"*(5-filled)+f"  `{uses}/{max_u}`"
    embed=discord.Embed(title="👤  Profile",description=f"Stats for {target.mention}",color=C_INFO)
    embed.set_thumbnail(url=target.display_avatar.url)
    embed.add_field(name="🎯 Total Gens",  value=f"**{total_gens}**",inline=True)
    embed.add_field(name="⭐ Vouches",     value=f"**{vouches}**",   inline=True)
    embed.add_field(name="\u200b",         value="\u200b",           inline=True)
    embed.add_field(name="🟢 Free gens",   value=f"**{free_g}**",   inline=True)
    embed.add_field(name="🟣 Premium gens",value=f"**{prem_g}**",   inline=True)
    embed.add_field(name="🟡 Paid gens",   value=f"**{paid_g}**",   inline=True)
    embed.add_field(name="🟢 Free quota",  value=bar(fu,1),          inline=True)
    embed.add_field(name="🟣 Prem quota",  value=bar(pu,3),          inline=True)
    embed.add_field(name="🟡 Paid quota",  value=bar(du,10),         inline=True)
    embed.set_footer(text="Quota resets every hour • Vouches never reset")
    embed.timestamp=discord.utils.utcnow()
    await interaction.followup.send(embed=embed)

# ── /leaderboard ──────────────────────────────────────────
@tree.command(name="leaderboard",description="Top 10 generators")
async def leaderboard(interaction:discord.Interaction):
    await interaction.response.defer()
    stats=load_json(STATS_FILE)
    user_stats={k:v for k,v in stats.items() if k.isdigit() and isinstance(v,int)}
    top=sorted(user_stats.items(),key=lambda x:x[1],reverse=True)[:10]
    medals={1:"🥇",2:"🥈",3:"🥉"}
    embed=discord.Embed(title="🏆  Leaderboard — Top Generators",color=C_PAID)
    if not top:
        embed.description="*No generations yet.*"
    else:
        lines=[]
        for i,(uid,count) in enumerate(top,1):
            u=interaction.guild.get_member(int(uid))
            name=u.display_name if u else f"User #{uid}"
            lines.append(f"{medals.get(i,f'`#{i}`')}  **{name}** — {count} gen{'s' if count>1 else ''}")
        embed.description="\n".join(lines)
    embed.set_footer(text=f"Requested by {interaction.user.display_name}"); embed.timestamp=discord.utils.utcnow()
    await interaction.followup.send(embed=embed)

# ── /add ──────────────────────────────────────────
@tree.command(name="add",description="[Staff] Add accounts from a .txt file")
@app_commands.describe(tier="Tier",service="Service name",file="The .txt file")
@app_commands.choices(tier=TIER_CHOICES)
async def add(interaction:discord.Interaction,tier:app_commands.Choice[str],service:str,file:discord.Attachment):
    await interaction.response.defer()
    m=interaction.guild.get_member(interaction.user.id)
    if not (is_helper(m) or is_mod(m)):
        return await interaction.followup.send(embed=embed_error("Access Denied","No permission."))
    if not file.filename.endswith(".txt"):
        return await interaction.followup.send(embed=embed_error("Invalid File","Only .txt files."))
    try:
        data=await file.read()
        lines=[l.decode().strip() for l in data.splitlines() if l.strip()]
    except Exception as ex:
        return await interaction.followup.send(embed=embed_error("Read Error",str(ex)))
    t=tier.value; service=normalize(service); path=f"{ACCOUNTS_DIR}/{t}/{service}.txt"
    stock=github_read(path); stock.extend(lines); github_write(path,stock)
    await interaction.followup.send(embed=embed_success("Stock Updated!",f"**{len(lines)}** accounts added to `{t}/{service}`. Total: **{len(stock)}**."))
    log=embed_log("📝 Stock Added",f"{interaction.user.mention} +{len(lines)} → `{t}/{service}`")
    await send_log(interaction.guild,log)

# ── /remove ──────────────────────────────────────────
@tree.command(name="remove",description="[Mod] Remove accounts from stock")
@app_commands.describe(tier="Tier",service="Service name",amount="Number to remove")
@app_commands.choices(tier=TIER_CHOICES)
async def remove(interaction:discord.Interaction,tier:app_commands.Choice[str],service:str,amount:int):
    await interaction.response.defer()
    m=interaction.guild.get_member(interaction.user.id)
    if not is_mod(m):
        return await interaction.followup.send(embed=embed_error("Access Denied","No permission."))
    if amount<1:
        return await interaction.followup.send(embed=embed_error("Invalid","Amount must be ≥ 1."))
    t=tier.value; service=normalize(service); path=f"{ACCOUNTS_DIR}/{t}/{service}.txt"
    stock=github_read(path)
    if len(stock)<amount:
        return await interaction.followup.send(embed=embed_warn("Insufficient Stock",f"Only **{len(stock)}** available."))
    stock=stock[amount:]; github_write(path,stock)
    await interaction.followup.send(embed=embed_success("Removed!",f"**{amount}** removed. Remaining: **{len(stock)}**."))
    log=embed_log("📝 Stock Removed",f"{interaction.user.mention} -{amount} from `{t}/{service}`")
    await send_log(interaction.guild,log)

# ── /send ──────────────────────────────────────────
@tree.command(name="send",description="[Staff] Send accounts via DM")
@app_commands.describe(member="Target",amount="Number of accounts",service="Service name")
async def send(interaction:discord.Interaction,member:discord.Member,amount:int,service:str):
    await interaction.response.defer()
    invoker=interaction.guild.get_member(interaction.user.id)
    if not (is_helper(invoker) or is_mod(invoker)):
        return await interaction.followup.send(embed=embed_error("Access Denied","No permission."))
    if amount<1:
        return await interaction.followup.send(embed=embed_error("Invalid","Amount must be ≥ 1."))
    if not is_mod(invoker):
        data=load_json(SEND_COOLDOWN_FILE); now=int(time.time()); key=str(interaction.user.id)
        uses=[t for t in data.get(key,[]) if now-t<3600]
        if len(uses)>=5:
            return await interaction.followup.send(embed=embed_warn("Limit","Max 5 sends per hour."))
        uses.append(now); data[key]=uses; save_json(SEND_COOLDOWN_FILE,data)
    service=normalize(service); sent=False
    for t in ["free","premium","paid"]:
        path=f"{ACCOUNTS_DIR}/{t}/{service}.txt"; stock=github_read(path)
        if len(stock)>=amount:
            accs=stock[:amount]; stock=stock[amount:]; github_write(path,stock)
            try:
                for i in range(0,len(accs),10):
                    chunk=accs[i:i+10]
                    dm=discord.Embed(title=f"📦 {service} ({t.upper()})",description="```\n"+"\n".join(chunk)+"\n```",color=TIER_COLOR[t])
                    dm.set_footer(text=f"Sent by {interaction.user.display_name} • Gen Bot"); dm.timestamp=discord.utils.utcnow()
                    await member.send(embed=dm)
                await interaction.followup.send(embed=embed_success("Sent!",f"**{amount}** **{service}** sent to {member.mention}."))
                sent=True
            except discord.Forbidden:
                await interaction.followup.send(embed=embed_warn("DMs Closed",f"Can't DM {member.mention}."))
            except Exception as ex:
                await interaction.followup.send(embed=embed_error("Error",str(ex)))
            break
    if not sent:
        await interaction.followup.send(embed=embed_error("No Stock",f"Not enough **{service}** accounts."))
    else:
        log=embed_log("📝 Direct Send",f"{interaction.user.mention} → {member.mention} x{amount} `{service}`")
        await send_log(interaction.guild,log)

# ── /help ──────────────────────────────────────────
@tree.command(name="help",description="List all commands")
async def help(interaction:discord.Interaction):
    embed=discord.Embed(title="📜  Commands — Gen Bot",description="All commands use `/`",color=C_INFO)
    embed.add_field(name="👥  Members",value="`/gen` `/profile` `/promote` `/leaderboard` `/stock`",inline=False)
    embed.add_field(name="🛡️  Staff",  value="`/redeem` `/add` `/send` `/remove` `/addv`",inline=False)
    embed.add_field(name="🏷️  Tiers",  value="🟢 `free` · 🟣 `premium` · 🟡 `paid`",inline=False)
    embed.set_footer(text="Gen Bot • Need help? Contact a staff member."); embed.timestamp=discord.utils.utcnow()
    await interaction.response.send_message(embed=embed)

# ── ERROR HANDLER ──────────────────────────────────────────
@tree.error
async def on_error(interaction:discord.Interaction,error:app_commands.AppCommandError):
    msg=str(error)
    try: await interaction.response.send_message(embed=embed_error("Error",msg))
    except discord.InteractionResponded: await interaction.followup.send(embed=embed_error("Error",msg))
    raise error

if __name__=="__main__" or __name__=="bot":
    bot.run(TOKEN)
