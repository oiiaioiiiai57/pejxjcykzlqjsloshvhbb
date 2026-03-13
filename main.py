"""
main.py — Lance le bot Discord ET le serveur web en parallèle.
Sur Railway, mettre comme Start Command : python main.py
"""

import threading
import os
import sys

# ── Lance le serveur Flask dans un thread séparé ──────────────────
def run_server():
    from server import app
    port = int(os.getenv("PORT", 8080))
    try:
        app.run(host="0.0.0.0", port=port, use_reloader=False)
    except Exception as e:
        print(f"❌ Server crashed: {e}")
        sys.exit(1)

# IMPORTANT: daemon=False so Flask stays alive even if bot crashes
server_thread = threading.Thread(target=run_server, daemon=False)
server_thread.start()
print("✅ Web server started")

# ── Lance le bot Discord (bloquant, dans le thread principal) ─────
try:
    import bot  # importe et exécute bot.py
except Exception as e:
    print(f"❌ Bot crashed: {e}")
    # Ne pas quitter — Flask reste actif
    server_thread.join()
