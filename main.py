"""
main.py — Lance le bot Discord ET le serveur web en parallèle.
Sur Railway, mettre comme Start Command : python main.py
"""

import threading
import os

# ── Lance le serveur Flask dans un thread séparé ──────────────────
def run_server():
    from server import app
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port, use_reloader=False)

server_thread = threading.Thread(target=run_server, daemon=True)
server_thread.start()
print("✅ Web server started")

# ── Lance le bot Discord (bloquant, dans le thread principal) ─────
import bot  # importe et exécute bot.py
