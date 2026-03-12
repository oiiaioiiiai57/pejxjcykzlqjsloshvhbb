"""
Gen Bot — Backend API avec Discord OAuth2
Variables d'environnement Railway :
  TOKEN                  = discord bot token
  GITHUB_TOKEN           = github personal access token
  DISCORD_CLIENT_ID      = 1481723412580929536
  DISCORD_CLIENT_SECRET  = ton secret
  DISCORD_REDIRECT_URI   = https://pejxjcykzlqjsloshvhbb-production.up.railway.app/auth/callback
"""

from flask import Flask, jsonify, request, redirect
from flask_cors import CORS
from github import Github, GithubException, Auth
import os, json, secrets
import requests as req

app  = Flask(__name__)
CORS(app, supports_credentials=True)

REPO_NAME    = "chevalier577pro/pejxjcykzlqjsloshvhbb"
ACCOUNTS_DIR = "accounts"
STATS_FILE   = "stats.json"

DISCORD_CLIENT_ID     = os.getenv("DISCORD_CLIENT_ID", "1481723412580929536")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET")
DISCORD_REDIRECT_URI  = os.getenv("DISCORD_REDIRECT_URI",
    "https://pejxjcykzlqjsloshvhbb-production.up.railway.app/auth/callback")
GUILD_ID = "1479080681572274320"

TIER_ROLES = {
    "free":    [1479080681970729122, 1479080681983316001],
    "premium": [1479080681983316003],
    "paid":    [1479080681983316002],
}

SESSIONS  = {}
COOLDOWNS = {}

import time as _time

COOLDOWN_LIMITS = {
    "free":    (1,  3600),
    "premium": (3,  3600),
    "paid":    (10, 3600),
}

STAFF_ROLE_ID = 1479080681983316007  # No cooldown

def check_cooldown(user_id, tier):
    now = int(_time.time())
    max_u, period = COOLDOWN_LIMITS[tier]
    bucket = COOLDOWNS.setdefault(user_id, {}).setdefault(tier, [])
    bucket[:] = [t for t in bucket if now - t < period]
    if len(bucket) >= max_u:
        wait = period - (now - bucket[0])
        return False, wait
    bucket.append(now)
    return True, 0

def send_dm_sync(user_id, account, service, tier):
    """Send account via Discord bot DM (sync requests)."""
    import requests as rq
    bot_token = os.getenv("TOKEN")
    if not bot_token:
        return
    headers = {"Authorization": f"Bot {bot_token}", "Content-Type": "application/json"}
    dm_res = rq.post("https://discord.com/api/v10/users/@me/channels",
        json={"recipient_id": user_id}, headers=headers)
    if not dm_res.ok:
        return
    channel_id = dm_res.json()["id"]
    colors = {"free": 0x39e07a, "premium": 0xa855f7, "paid": 0xf5c842}
    embed = {
        "title": f"\u26a1 {service} \u2014 {tier.upper()}",
        "description": f"```\n{account}\n```",
        "color": colors.get(tier, 0x5c6bff),
        "footer": {"text": "Gen Bot \u2022 Web Generation"},
    }
    rq.post(f"https://discord.com/api/v10/channels/{channel_id}/messages",
        json={"embeds": [embed]}, headers=headers)

# ------------------ GITHUB ------------------
_gc = None
_ro = None

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
    except GithubException:
        return []

def github_write(path, data):
    content = "\n".join(data) + "\n"
    try:
        f = repo.get_contents(path)
        repo.update_file(f.path, "Update stock", content, f.sha)
    except GithubException:
        repo.create_file(path, "Create stock", content)

def load_json(path):
    try:
        f = repo.get_contents(path)
        return json.loads(f.decoded_content.decode())
    except Exception:
        return {}

def save_json(path, data):
    content = json.dumps(data, indent=4) + "\n"
    try:
        f = repo.get_contents(path)
        repo.update_file(f.path, "Update JSON", content, f.sha)
    except GithubException:
        repo.create_file(path, "Create JSON", content)

def normalize(s):
    return s.capitalize()

# ------------------ OAUTH2 ------------------

def get_user_tier(role_ids):
    role_set = set(role_ids)
    if role_set & set(TIER_ROLES["paid"]):    return "paid"
    if role_set & set(TIER_ROLES["premium"]): return "premium"
    if role_set & set(TIER_ROLES["free"]):    return "free"
    return None

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
    site = "https://chevalier577pro.github.io/pejxjcykzlqjsloshvhbb"
    if not code:
        return redirect(f"{site}?error=no_code")

    token_res = req.post("https://discord.com/api/oauth2/token", data={
        "client_id":     DISCORD_CLIENT_ID,
        "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type":    "authorization_code",
        "code":          code,
        "redirect_uri":  DISCORD_REDIRECT_URI,
    }, headers={"Content-Type": "application/x-www-form-urlencoded"})

    if not token_res.ok:
        return redirect(f"{site}?error=token_failed")

    access_token = token_res.json()["access_token"]

    user = req.get("https://discord.com/api/users/@me",
        headers={"Authorization": f"Bearer {access_token}"}).json()

    member_res = req.get(
        f"https://discord.com/api/users/@me/guilds/{GUILD_ID}/member",
        headers={"Authorization": f"Bearer {access_token}"})

    # User must be in the guild
    if not member_res.ok:
        return redirect(f"{site}?error=not_in_server")

    role_ids = [int(r) for r in member_res.json().get("roles", [])]
    tier     = get_user_tier(role_ids)
    is_staff = STAFF_ROLE_ID in role_ids

    session_token = secrets.token_urlsafe(32)
    SESSIONS[session_token] = {
        "user_id":  user["id"],
        "username": user["username"],
        "avatar":   user.get("avatar"),
        "tier":     tier,
        "is_staff": is_staff,
        "in_guild": True,
    }

    return redirect(f"{site}?token={session_token}")

@app.route("/auth/me")
def auth_me():
    token = request.headers.get("X-Session-Token") or request.args.get("token")
    session = SESSIONS.get(token)
    if not session:
        return jsonify({"error": "Not logged in"}), 401
    return jsonify(session)

@app.route("/auth/logout", methods=["POST"])
def auth_logout():
    token = request.headers.get("X-Session-Token")
    SESSIONS.pop(token, None)
    return jsonify({"ok": True})

# ------------------ STOCK ------------------

@app.route("/api/stock")
def get_stock():
    tiers = ["free", "premium", "paid"]
    result = {}
    total  = 0
    for tier in tiers:
        services = []
        try:
            files = repo.get_contents(f"{ACCOUNTS_DIR}/{tier}")
            if not isinstance(files, list): files = [files]
            for f in files:
                if not f.name.endswith(".txt"): continue
                count = len(github_read(f.path))
                total += count
                services.append({"name": f.name.replace(".txt",""), "count": count})
        except GithubException:
            pass
        result[tier] = sorted(services, key=lambda x: x["name"])
    return jsonify({"tiers": result, "total": total})

# ------------------ GEN ------------------

@app.route("/api/gen", methods=["POST"])
def web_gen():
    data    = request.get_json(silent=True) or {}
    token   = request.headers.get("X-Session-Token") or data.get("token")
    session = SESSIONS.get(token)

    if not session:
        return jsonify({"error": "Not logged in"}), 401

    user_id   = session.get("user_id")
    user_tier = session.get("tier")
    username  = session.get("username", "Unknown")

    if not user_tier:
        return jsonify({"error": "Tu n'as pas le rôle nécessaire pour générer."}), 403

    req_tier = data.get("tier", "").lower()
    service  = normalize(data.get("service", ""))

    if req_tier not in ["free", "premium", "paid"]:
        return jsonify({"error": "Tier invalide."}), 400

    # Check tier permission
    allowed = {"free": ["free"], "premium": ["free","premium"], "paid": ["free","premium","paid"]}
    if req_tier not in allowed.get(user_tier, []):
        return jsonify({"error": f"Ton rôle permet seulement le tier {user_tier}."}), 403

    # Check cooldown (staff bypass)
    is_staff = session.get("is_staff", False)
    if not is_staff:
        ok, wait = check_cooldown(user_id, req_tier)
        if not ok:
            mins = wait // 60
            secs = wait % 60
            return jsonify({"error": f"Cooldown ! Réessaie dans {mins}m {secs}s."}), 429

    if not service:
        return jsonify({"error": "Service requis."}), 400

    path  = f"{ACCOUNTS_DIR}/{req_tier}/{service}.txt"
    stock = github_read(path)
    if not stock:
        return jsonify({"error": f"Out of stock pour {service} ({req_tier})"}), 404

    account = stock.pop(0)
    github_write(path, stock)

    # Send DM to user
    try:
        send_dm_sync(user_id, account, service, req_tier)
    except Exception as e:
        print(f"DM failed: {e}")

    # Update stats
    stats = load_json(STATS_FILE)
    stats["web_gens"] = stats.get("web_gens", 0) + 1
    save_json(STATS_FILE, stats)

    return jsonify({"account": account, "service": service, "tier": req_tier, "dm_sent": True})

# ------------------ STATS ------------------

@app.route("/api/stats")
def get_stats():
    stats = load_json(STATS_FILE)
    total = sum(v for k,v in stats.items() if k != "web_gens" and isinstance(v, int))
    return jsonify({"total_gens": total, "web_gens": stats.get("web_gens", 0)})

@app.route("/health")
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
