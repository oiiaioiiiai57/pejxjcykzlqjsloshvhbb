"""
Gen Bot — Backend API (multi-serveur)
"""

from flask import Flask, jsonify, request, redirect
from flask_cors import CORS
from github import Github, GithubException, Auth
import os, json, secrets, datetime, random, string, time as _time
import requests as req
import threading

app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app, supports_credentials=True, origins="*")

# ── SERVIR LES FICHIERS HTML STATIQUES ───────────────────────
@app.route("/")
def serve_index():
    return app.send_static_file("index.html")

@app.route("/profile.html")
def serve_profile():
    return app.send_static_file("profile.html")

@app.route("/ticket.html")
def serve_ticket():
    return app.send_static_file("ticket.html")

# ── CONFIG ───────────────────────────────────────────────────
REPO_NAME     = "chevalier577pro/pejxjcykzlqjsloshvhbb"
ACCOUNTS_DIR  = "accounts"
STATS_FILE    = "stats.json"
SESSIONS_FILE = "web_sessions.json"
GENLOG_FILE   = "web_genlog.json"
TICKETS_FILE  = "web_tickets.json"

SITE = "https://pejxjcykzlqjsloshvhbb-production.up.railway.app"

DISCORD_CLIENT_ID     = os.getenv("DISCORD_CLIENT_ID", "1481723412580929536")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET")
DISCORD_REDIRECT_URI  = os.getenv("DISCORD_REDIRECT_URI",
    "https://pejxjcykzlqjsloshvhbb-production.up.railway.app/auth/callback")
BOT_SECRET = os.getenv("BOT_SECRET", "genbotinternal")

# ── CONFIG MULTI-SERVEUR ──────────────────────────────────────
# Chaque serveur a ses propres rôles, catégorie tickets, logs
GUILDS = {
    "1479080681572274320": {
        "name": "Serveur 1",
        "staff_role":       1479080681983316004,
        "staff_role_id":    1479080681983316007,
        "ticket_category":  1479080682784555134,
        "log_channel":      1479239531499880628,
        "tier_roles": {
            "free":    [1479080681970729122, 1479080681983316001],
            "premium": [1479080681983316003],
            "paid":    [1479080681983316002, 1479080681983316007],
        },
    },
    "1479133088524009514": {
        "name": "Serveur 2",
        "staff_role":       1482070883525722123,
        "staff_role_id":    1482070883525722123,
        "ticket_category":  1482070942766071888,
        "log_channel":      1482070978938015867,
        "tier_roles": {
            "free":    [1482070899023806574, 1482070889121054892],
            "premium": [1482070887497863228],
            "paid":    [1482070888479326219],
        },
    },
}

COOLDOWN_LIMITS = {"free": (1,3600), "premium": (3,3600), "paid": (10,3600)}

# ── MÉMOIRE RUNTIME ──────────────────────────────────────────
COOLDOWNS       = {}
WEB_TICKETS     = {}
_tickets_loaded = False

# ── CACHE GITHUB ─────────────────────────────────────────────
_json_cache = {}
CACHE_TTL   = 30

def _cache_get(path):
    if path in _json_cache:
        data, ts = _json_cache[path]
        if _time.time() - ts < CACHE_TTL:
            return data
    return None

def _cache_set(path, data):
    _json_cache[path] = (data, _time.time())

def _cache_invalidate(path):
    _json_cache.pop(path, None)

# ── GITHUB ───────────────────────────────────────────────────
_gc = None; _ro = None

def get_repo():
    global _gc, _ro
    if _ro is None:
        t = os.getenv("GITHUB_TOKEN")
        if not t: raise RuntimeError("GITHUB_TOKEN not set")
        _gc = Github(auth=Auth.Token(t))
        _ro = _gc.get_repo(REPO_NAME)
    return _ro

class LazyRepo:
    def get_contents(self, *a, **kw): return get_repo().get_contents(*a, **kw)
    def update_file(self, *a, **kw):  return get_repo().update_file(*a, **kw)
    def create_file(self, *a, **kw):  return get_repo().create_file(*a, **kw)

repo = LazyRepo()

def github_read(path):
    try:
        f = repo.get_contents(path)
        return [l.strip() for l in f.decoded_content.decode().splitlines() if l.strip()]
    except GithubException: return []

def github_write(path, data):
    content = "\n".join(data) + "\n"
    try:
        f = repo.get_contents(path)
        repo.update_file(f.path, "Update stock", content, f.sha)
    except GithubException:
        repo.create_file(path, "Create stock", content)

def load_json(path):
    cached = _cache_get(path)
    if cached is not None:
        return cached
    try:
        f = repo.get_contents(path)
        data = json.loads(f.decoded_content.decode())
        _cache_set(path, data)
        return data
    except: return {}

def save_json(path, data):
    _cache_invalidate(path)
    content = json.dumps(data, indent=4) + "\n"
    try:
        f = repo.get_contents(path)
        repo.update_file(f.path, "Update JSON", content, f.sha)
    except GithubException:
        repo.create_file(path, "Create JSON", content)
    _cache_set(path, data)

def normalize(s): return s.capitalize()

# ── TICKETS ───────────────────────────────────────────────────
def _ensure_tickets_loaded():
    global WEB_TICKETS, _tickets_loaded
    if not _tickets_loaded:
        try:
            WEB_TICKETS = load_json(TICKETS_FILE)
        except:
            WEB_TICKETS = {}
        _tickets_loaded = True

def _save_ticket(ticket_id):
    def _do_save():
        try:
            _cache_invalidate(TICKETS_FILE)
            all_t = load_json(TICKETS_FILE)
            all_t[ticket_id] = WEB_TICKETS[ticket_id]
            save_json(TICKETS_FILE, all_t)
        except Exception as e:
            print(f"save_ticket error: {e}")
    threading.Thread(target=_do_save, daemon=True).start()

def _get_ticket(ticket_id):
    _ensure_tickets_loaded()
    if ticket_id in WEB_TICKETS:
        return WEB_TICKETS[ticket_id]
    _cache_invalidate(TICKETS_FILE)
    all_t = load_json(TICKETS_FILE)
    if ticket_id in all_t:
        WEB_TICKETS[ticket_id] = all_t[ticket_id]
        return WEB_TICKETS[ticket_id]
    return None

# ── SESSIONS ─────────────────────────────────────────────────
_session_cache = {}
_session_dirty = {}

def _flush_sessions():
    while True:
        _time.sleep(60)
        if not _session_dirty:
            continue
        try:
            all_s = load_json(SESSIONS_FILE)
            all_s.update(_session_dirty)
            save_json(SESSIONS_FILE, all_s)
            _session_dirty.clear()
        except Exception as e:
            print(f"Session flush error: {e}")

threading.Thread(target=_flush_sessions, daemon=True).start()

def get_session(token):
    if not token:
        return None
    if token in _session_cache:
        return _session_cache[token]
    all_s = load_json(SESSIONS_FILE)
    if token in all_s:
        _session_cache[token] = all_s[token]
        return all_s[token]
    return None

def set_session(token, data):
    _session_cache[token] = data
    _session_dirty[token] = data
    def _save():
        try:
            all_s = load_json(SESSIONS_FILE)
            all_s[token] = data
            save_json(SESSIONS_FILE, all_s)
            _session_dirty.pop(token, None)
        except Exception as e:
            print(f"set_session error: {e}")
    threading.Thread(target=_save, daemon=True).start()

def del_session(token):
    _session_cache.pop(token, None)
    _session_dirty.pop(token, None)
    def _save():
        try:
            all_s = load_json(SESSIONS_FILE)
            all_s.pop(token, None)
            save_json(SESSIONS_FILE, all_s)
        except Exception as e:
            print(f"del_session error: {e}")
    threading.Thread(target=_save, daemon=True).start()

_genlog_cache = {}

# ── COOLDOWN ──────────────────────────────────────────────────
def check_cooldown(user_id, tier):
    now = int(_time.time())
    max_u, period = COOLDOWN_LIMITS[tier]
    bucket = COOLDOWNS.setdefault(user_id, {}).setdefault(tier, [])
    bucket[:] = [t for t in bucket if now - t < period]
    if len(bucket) >= max_u:
        return False, period - (now - bucket[0])
    bucket.append(now)
    return True, 0

# ── DISCORD API ───────────────────────────────────────────────
def _dheaders():
    return {"Authorization": f"Bot {os.getenv('TOKEN')}", "Content-Type": "application/json"}

def discord_send(channel_id, **kwargs):
    req.post(f"https://discord.com/api/v10/channels/{channel_id}/messages",
        json=kwargs, headers=_dheaders())

def discord_create_ticket_channel(user_id, username, service, tier, code, ticket_id, guild_cfg, guild_id):
    """Crée le salon ticket Discord dans le bon serveur."""
    tname = f"web-{service.lower()}-{username.lower()[:10]}-{random.randint(1000,9999)}"
    overwrites = [
        {"id": str(guild_id), "type": 0, "deny": "1024"},
        {"id": str(user_id),  "type": 1, "allow": "0"},
        {"id": str(guild_cfg["staff_role"]), "type": 0, "allow": "1024"},
    ]
    ch_r = req.post(f"https://discord.com/api/v10/guilds/{guild_id}/channels",
        headers=_dheaders(), json={
            "name": tname, "type": 0,
            "parent_id": str(guild_cfg["ticket_category"]),
            "permission_overwrites": overwrites,
        })
    if not ch_r.ok:
        print(f"Channel create failed: {ch_r.text}")
        return None

    channel_id = ch_r.json()["id"]
    colors = {"free": 0x57F287, "premium": 0xA855F7, "paid": 0xFFD166}
    embed = {
        "title": "🌐  Web Generation Ticket",
        "description": f"**{username}** a généré un compte depuis le site web.",
        "color": colors.get(tier, 0x5865F2),
        "fields": [
            {"name": "👤 Membre",    "value": f"**{username}**",   "inline": True},
            {"name": "📦 Service",   "value": f"**{service}**",    "inline": True},
            {"name": "🏷️ Tier",     "value": tier.upper(),         "inline": True},
            {"name": "🔑 Code",      "value": f"```{code}```",     "inline": False},
            {"name": "📋 Commande",  "value": f"`/redeem {code}`", "inline": False},
            {"name": "🌐 Ticket web","value": f"{SITE}/ticket.html?id={ticket_id}", "inline": False},
        ],
        "footer": {"text": "Gen Bot • Web Generation"},
        "timestamp": datetime.datetime.utcnow().isoformat(),
    }
    discord_send(channel_id, content=f"<@&{guild_cfg['staff_role']}>", embeds=[embed])
    return channel_id

def discord_close_ticket_channel(channel_id):
    req.delete(f"https://discord.com/api/v10/channels/{channel_id}", headers=_dheaders())

def discord_log(embed_data, guild_cfg):
    discord_send(guild_cfg["log_channel"], embeds=[embed_data])

# ── OAUTH2 ────────────────────────────────────────────────────
def get_user_tier_for_guild(role_ids, guild_cfg):
    rs = set(role_ids)
    if rs & set(guild_cfg["tier_roles"]["paid"]):    return "paid"
    if rs & set(guild_cfg["tier_roles"]["premium"]): return "premium"
    if rs & set(guild_cfg["tier_roles"]["free"]):    return "free"
    return None

def get_user_info_from_guilds(access_token):
    """
    Vérifie l'appartenance aux serveurs dans l'ordre.
    Retourne (guild_id, tier, is_staff) du premier serveur trouvé avec un rôle valide.
    """
    for guild_id, guild_cfg in GUILDS.items():
        member_res = req.get(
            f"https://discord.com/api/users/@me/guilds/{guild_id}/member",
            headers={"Authorization": f"Bearer {access_token}"})
        if not member_res.ok:
            continue
        role_ids = [int(r) for r in member_res.json().get("roles", [])]
        tier     = get_user_tier_for_guild(role_ids, guild_cfg)
        is_staff = guild_cfg["staff_role_id"] in role_ids
        if tier or is_staff:
            return guild_id, tier, is_staff
    return None, None, False

@app.route("/auth/login")
def auth_login():
    from urllib.parse import quote
    url = (
        "https://discord.com/oauth2/authorize"
        f"?client_id={DISCORD_CLIENT_ID}"
        f"&redirect_uri={quote(DISCORD_REDIRECT_URI)}"
        "&response_type=code"
        "&scope=identify%20guilds.members.read"
    )
    return redirect(url)

@app.route("/auth/callback")
def auth_callback():
    code = request.args.get("code")
    if not code:
        return redirect(f"{SITE}?error=no_code")

    token_res = req.post("https://discord.com/api/oauth2/token", data={
        "client_id": DISCORD_CLIENT_ID, "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code", "code": code,
        "redirect_uri": DISCORD_REDIRECT_URI,
    }, headers={"Content-Type": "application/x-www-form-urlencoded"})

    if not token_res.ok:
        return redirect(f"{SITE}?error=token_failed")

    access_token = token_res.json()["access_token"]
    user = req.get("https://discord.com/api/users/@me",
        headers={"Authorization": f"Bearer {access_token}"}).json()

    guild_id, tier, is_staff = get_user_info_from_guilds(access_token)

    if not guild_id:
        return redirect(f"{SITE}?error=not_in_server")

    session_token = secrets.token_urlsafe(32)
    session_data = {
        "user_id":   user["id"],
        "username":  user["username"],
        "avatar":    user.get("avatar"),
        "tier":      tier,
        "is_staff":  is_staff,
        "guild_id":  guild_id,
        "created_at": datetime.datetime.utcnow().isoformat(),
    }
    set_session(session_token, session_data)
    return redirect(f"{SITE}?token={session_token}")

@app.route("/auth/me")
def auth_me():
    token = request.headers.get("X-Session-Token") or request.args.get("token")
    session = get_session(token)
    if not session:
        return jsonify({"error": "Not logged in"}), 401
    return jsonify(session)

@app.route("/auth/logout", methods=["POST"])
def auth_logout():
    token = request.headers.get("X-Session-Token")
    del_session(token)
    return jsonify({"ok": True})

# ── STOCK ─────────────────────────────────────────────────────
@app.route("/api/stock")
def get_stock():
    tiers = ["free", "premium", "paid"]
    result = {}; total = 0
    for tier in tiers:
        services = []
        try:
            files = repo.get_contents(f"{ACCOUNTS_DIR}/{tier}")
            if not isinstance(files, list): files = [files]
            for f in files:
                if not f.name.endswith(".txt"): continue
                count = len(github_read(f.path)); total += count
                services.append({"name": f.name.replace(".txt",""), "count": count})
        except GithubException: pass
        result[tier] = sorted(services, key=lambda x: x["name"])
    return jsonify({"tiers": result, "total": total})

# ── GEN ───────────────────────────────────────────────────────
@app.route("/api/gen", methods=["POST"])
def web_gen():
    data    = request.get_json(silent=True) or {}
    token   = request.headers.get("X-Session-Token") or data.get("token")
    session = get_session(token)
    if not session: return jsonify({"error": "Not logged in"}), 401

    user_id   = session["user_id"]
    user_tier = session.get("tier")
    username  = session.get("username", "Unknown")
    is_staff  = session.get("is_staff", False)
    guild_id  = session.get("guild_id", list(GUILDS.keys())[0])
    guild_cfg = GUILDS.get(guild_id, GUILDS[list(GUILDS.keys())[0]])

    if not user_tier: return jsonify({"error": "Tu n'as pas le rôle nécessaire."}), 403

    req_tier = data.get("tier", "").lower()
    service  = normalize(data.get("service", ""))

    if req_tier not in ["free","premium","paid"]: return jsonify({"error": "Tier invalide."}), 400

    allowed = {"free":["free"],"premium":["free","premium"],"paid":["free","premium","paid"]}
    if req_tier not in allowed.get(user_tier, []):
        return jsonify({"error": f"Ton rôle permet seulement le tier {user_tier}."}), 403

    if not is_staff:
        ok, wait = check_cooldown(user_id, req_tier)
        if not ok:
            return jsonify({"error": f"Cooldown ! Réessaie dans {wait//60}m {wait%60}s."}), 429

    if not service: return jsonify({"error": "Service requis."}), 400

    path  = f"{ACCOUNTS_DIR}/{req_tier}/{service}.txt"
    stock = github_read(path)
    if not stock: return jsonify({"error": f"Out of stock pour {service} ({req_tier})"}), 404

    account   = stock.pop(0)
    github_write(path, stock)

    code      = ''.join(random.choices(string.ascii_uppercase+string.digits, k=6))
    ticket_id = secrets.token_urlsafe(16)

    pending = load_json("pending.json")
    pending[code] = {"account": account, "user": int(user_id), "web_ticket_id": ticket_id, "tier": req_tier, "service": service}
    save_json("pending.json", pending)

    try:
        discord_ch = discord_create_ticket_channel(user_id, username, service, req_tier, code, ticket_id, guild_cfg, guild_id)
    except Exception as e:
        print(f"Discord ticket error: {e}"); discord_ch = None

    _ensure_tickets_loaded()

    WEB_TICKETS[ticket_id] = {
        "user_id": user_id, "username": username, "service": service,
        "tier": req_tier, "code": code, "account": account,
        "discord_channel_id": discord_ch,
        "guild_id": guild_id,
        "redeemed": False, "closed": False,
        "messages": [], "msg_counter": 0,
        "created_at": datetime.datetime.utcnow().isoformat(),
    }
    _save_ticket(ticket_id)

    genlog  = load_json(GENLOG_FILE)
    uid_key = str(user_id)
    if uid_key not in genlog: genlog[uid_key] = []
    genlog[uid_key].insert(0, {
        "ticket_id": ticket_id, "service": service, "tier": req_tier,
        "date": datetime.datetime.utcnow().isoformat(), "account": None,
    })
    genlog[uid_key] = genlog[uid_key][:50]
    _genlog_cache[uid_key] = genlog[uid_key]
    save_json(GENLOG_FILE, genlog)

    stats = load_json(STATS_FILE)
    stats["web_gens"] = stats.get("web_gens", 0) + 1
    save_json(STATS_FILE, stats)

    try:
        discord_log({
            "title": "📝 Web Generation",
            "description": f"**{username}** a gen **{service}** ({req_tier})",
            "color": 0x5865F2,
            "timestamp": datetime.datetime.utcnow().isoformat(),
        }, guild_cfg)
    except: pass

    return jsonify({"ticket_id": ticket_id, "service": service, "tier": req_tier})

# ── TICKET ROUTES ─────────────────────────────────────────────
def _auth_ticket(ticket_id):
    token = request.headers.get("X-Session-Token") or request.args.get("token")
    session = get_session(token)
    if not session: return None, None, jsonify({"error":"Not logged in"}), 401
    t = _get_ticket(ticket_id)
    if not t: return None, None, jsonify({"error":"Ticket not found"}), 404
    if t["user_id"] != session["user_id"] and not session.get("is_staff"):
        return None, None, jsonify({"error":"Forbidden"}), 403
    return session, t, None, None

@app.route("/api/ticket/<ticket_id>")
def get_ticket(ticket_id):
    session, t, err, code = _auth_ticket(ticket_id)
    if err: return err, code
    return jsonify({
        "ticket_id": ticket_id, "service": t["service"], "tier": t["tier"],
        "code": t["code"], "redeemed": t["redeemed"], "closed": t["closed"],
        "account": t["account"] if t["redeemed"] else None,
        "created_at": t["created_at"],
    })

@app.route("/api/ticket/<ticket_id>/messages", methods=["GET"])
def get_messages(ticket_id):
    session, t, err, code = _auth_ticket(ticket_id)
    if err: return err, code
    after    = int(request.args.get("after", 0))
    new_msgs = [m for m in t["messages"] if m["id"] > after]
    return jsonify({
        "messages": new_msgs, "redeemed": t["redeemed"],
        "closed": t["closed"], "account": t["account"] if t["redeemed"] else None,
    })

@app.route("/api/ticket/<ticket_id>/messages", methods=["POST"])
def post_message(ticket_id):
    token   = request.headers.get("X-Session-Token")
    session = get_session(token)
    if not session: return jsonify({"error":"Not logged in"}), 401
    t = _get_ticket(ticket_id)
    if not t: return jsonify({"error":"Ticket not found"}), 404
    if t["user_id"] != session["user_id"] and not session.get("is_staff"):
        return jsonify({"error":"Forbidden"}), 403
    if t["closed"]: return jsonify({"error":"Ticket closed"}), 400

    data    = request.get_json(silent=True) or {}
    content = data.get("content","").strip()[:500]
    if not content: return jsonify({"error":"Empty message"}), 400

    t["msg_counter"] += 1
    is_staff = session.get("is_staff", False)
    msg = {
        "id":          t["msg_counter"],
        "content":     content,
        "author_type": "staff" if is_staff else "member",
        "author_name": session["username"],
        "timestamp":   datetime.datetime.utcnow().isoformat(),
    }
    t["messages"].append(msg)

    try:
        if t["discord_channel_id"]:
            color = 0x5865F2 if is_staff else 0x39e07a
            discord_send(t["discord_channel_id"], embeds=[{
                "description": content,
                "color": color,
                "author": {"name": f"{'🛡️' if is_staff else '👤'} {session['username']} (web)"},
                "timestamp": datetime.datetime.utcnow().isoformat(),
            }])
    except Exception as e:
        print(f"Bridge error: {e}")

    return jsonify({"ok": True, "msg": msg})

@app.route("/api/ticket/<ticket_id>/close", methods=["POST"])
def close_ticket_web(ticket_id):
    token   = request.headers.get("X-Session-Token")
    session = get_session(token)
    if not session: return jsonify({"error":"Not logged in"}), 401
    if not session.get("is_staff"): return jsonify({"error":"Staff only"}), 403
    t = _get_ticket(ticket_id)
    if not t: return jsonify({"error":"Not found"}), 404

    t["closed"] = True
    _save_ticket(ticket_id)

    guild_id  = t.get("guild_id", list(GUILDS.keys())[0])
    guild_cfg = GUILDS.get(guild_id, GUILDS[list(GUILDS.keys())[0]])

    if t["discord_channel_id"]:
        try:
            discord_send(t["discord_channel_id"], embeds=[{
                "title": "🔒 Ticket fermé depuis le site",
                "color": 0xED4245,
                "footer": {"text": f"Fermé par {session['username']}"},
                "timestamp": datetime.datetime.utcnow().isoformat(),
            }])
            threading.Timer(5.0, lambda: discord_close_ticket_channel(t["discord_channel_id"])).start()
        except: pass
    return jsonify({"ok": True})

# ── ROUTES INTERNES BOT ───────────────────────────────────────
@app.route("/internal/ticket/<ticket_id>/redeem", methods=["POST"])
def internal_redeem(ticket_id):
    if request.headers.get("X-Bot-Secret") != BOT_SECRET:
        return jsonify({"error":"Forbidden"}), 403
    t = _get_ticket(ticket_id)
    if not t: return jsonify({"error":"Not found"}), 404
    data    = request.get_json(silent=True) or {}
    account = data.get("account", t.get("account"))
    t["redeemed"] = True
    t["account"]  = account
    try:
        genlog  = load_json(GENLOG_FILE)
        uid_key = str(t["user_id"])
        for entry in genlog.get(uid_key, []):
            if entry.get("ticket_id") == ticket_id:
                entry["account"] = account; break
        save_json(GENLOG_FILE, genlog)
    except Exception as e:
        print(f"genlog update failed: {e}")
    _save_ticket(ticket_id)
    return jsonify({"ok": True})

@app.route("/internal/ticket/<ticket_id>/close", methods=["POST"])
def internal_close(ticket_id):
    if request.headers.get("X-Bot-Secret") != BOT_SECRET:
        return jsonify({"error":"Forbidden"}), 403
    t = _get_ticket(ticket_id)
    if not t: return jsonify({"error":"Not found"}), 404
    t["closed"] = True
    _save_ticket(ticket_id)
    return jsonify({"ok": True})

@app.route("/internal/ticket/<ticket_id>/message", methods=["POST"])
def internal_message(ticket_id):
    if request.headers.get("X-Bot-Secret") != BOT_SECRET:
        return jsonify({"error":"Forbidden"}), 403
    t = _get_ticket(ticket_id)
    if not t: return jsonify({"ok": True})
    data    = request.get_json(silent=True) or {}
    content = data.get("content","").strip()[:500]
    author  = data.get("author","Staff")
    if not content: return jsonify({"ok":True})
    t["msg_counter"] += 1
    t["messages"].append({
        "id":          t["msg_counter"],
        "content":     content,
        "author_type": "staff",
        "author_name": author,
        "timestamp":   datetime.datetime.utcnow().isoformat(),
    })
    return jsonify({"ok": True})

@app.route("/api/profile")
def get_profile():
    token = request.headers.get("X-Session-Token") or request.args.get("token")
    session = get_session(token)
    if not session: return jsonify({"error":"Not logged in"}), 401
    uid = str(session["user_id"])
    if uid in _genlog_cache:
        genlog = _genlog_cache[uid]
    else:
        all_log = load_json(GENLOG_FILE)
        genlog = all_log.get(uid, [])
        _genlog_cache[uid] = genlog
    return jsonify({**session, "gen_history": genlog})

@app.route("/api/stats")
def get_stats():
    stats = load_json(STATS_FILE)
    total = sum(v for k,v in stats.items() if k != "web_gens" and isinstance(v,int))
    return jsonify({"total_gens": total, "web_gens": stats.get("web_gens",0)})

@app.route("/internal/tickets_map")
def tickets_map():
    if request.headers.get("X-Bot-Secret") != BOT_SECRET:
        return jsonify({"error":"Forbidden"}), 403
    _ensure_tickets_loaded()
    result = {}
    for tid, t in WEB_TICKETS.items():
        if t.get("discord_channel_id") and not t.get("closed"):
            result[tid] = t["discord_channel_id"]
    return jsonify(result)

@app.route("/health")
def health():
    return jsonify({"status":"ok"})

_ensure_tickets_loaded()

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
