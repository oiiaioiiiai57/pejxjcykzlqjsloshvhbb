"""
Gen Bot — Backend API
Déployer sur Railway avec les variables d'environnement :
  TOKEN         = discord bot token
  GITHUB_TOKEN  = github personal access token
  WEB_SECRET    = un mot de passe que TU choisis pour protéger /api/gen
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from github import Github, GithubException, Auth
import os
import json

app = Flask(__name__)
CORS(app)  # autorise le site à appeler l'API

# ------------------ CONFIG ------------------
DISCORD_TOKEN = os.getenv("TOKEN")
WEB_SECRET   = os.getenv("WEB_SECRET", "changeme")  # mot de passe pour /api/gen
REPO_NAME    = "chevalier577pro/pejxjcykzlqjsloshvhbb"

TICKET_CATEGORY = 1479080682784555134
STAFF_ROLE      = 1479080681983316004
LOG_CHANNEL     = 1479239531499880628

ACCOUNTS_DIR  = "accounts"
PENDING_FILE  = "pending.json"
STATS_FILE    = "stats.json"

_github_client = None
_repo = None

def get_repo():
    global _github_client, _repo
    if _repo is None:
        token = os.getenv("GITHUB_TOKEN")
        if not token:
            raise RuntimeError("GITHUB_TOKEN is not set!")
        _github_client = Github(auth=Auth.Token(token))
        _repo = _github_client.get_repo(REPO_NAME)
    return _repo

class LazyRepo:
    def get_contents(self, *a, **kw): return get_repo().get_contents(*a, **kw)
    def update_file(self, *a, **kw):  return get_repo().update_file(*a, **kw)
    def create_file(self, *a, **kw):  return get_repo().create_file(*a, **kw)

repo = LazyRepo()

# ------------------ GITHUB HELPERS ------------------
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

# ------------------ ROUTES ------------------

@app.route("/api/stock")
def get_stock():
    """Return full stock across all tiers."""
    tiers = ["free", "premium", "paid"]
    result = {}
    total  = 0

    for tier in tiers:
        services = []
        try:
            files = repo.get_contents(f"{ACCOUNTS_DIR}/{tier}")
            if not isinstance(files, list):
                files = [files]
            for f in files:
                if not f.name.endswith(".txt"):
                    continue
                count = len(github_read(f.path))
                total += count
                services.append({"name": f.name.replace(".txt", ""), "count": count})
        except GithubException:
            pass
        result[tier] = sorted(services, key=lambda x: x["name"])

    return jsonify({"tiers": result, "total": total})


@app.route("/api/gen", methods=["POST"])
def web_gen():
    """
    Generate an account from the website.
    Body JSON: { "secret": "...", "tier": "free|premium|paid", "service": "Netflix" }
    Returns the account directly (no ticket system for web gens).
    """
    data = request.get_json(silent=True) or {}

    # Auth check
    if data.get("secret") != WEB_SECRET:
        return jsonify({"error": "Invalid password"}), 401

    tier    = data.get("tier", "").lower()
    service = normalize(data.get("service", ""))

    if tier not in ["free", "premium", "paid"]:
        return jsonify({"error": "Invalid tier"}), 400
    if not service:
        return jsonify({"error": "Service required"}), 400

    path  = f"{ACCOUNTS_DIR}/{tier}/{service}.txt"
    stock = github_read(path)

    if not stock:
        return jsonify({"error": f"Out of stock for {service} ({tier})"}), 404

    account = stock.pop(0)
    github_write(path, stock)

    # Update stats (anonymous web gen)
    stats = load_json(STATS_FILE)
    stats["web_gens"] = stats.get("web_gens", 0) + 1
    save_json(STATS_FILE, stats)

    return jsonify({"account": account, "service": service, "tier": tier})


@app.route("/api/stats")
def get_stats():
    """Return total gen count."""
    stats = load_json(STATS_FILE)
    total = sum(v for k, v in stats.items() if k != "web_gens" and isinstance(v, int))
    return jsonify({"total_gens": total, "web_gens": stats.get("web_gens", 0)})


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
