import { loadGuildConfig } from "./config.js";
import { startServer } from "./server.js";
import { startBot    } from "./bot.js";

// Charger la config des guilds depuis GitHub avant de démarrer
loadGuildConfig().then(() => {
  startServer();
  startBot();
}).catch(e => {
  console.error("Failed to load guild config, starting with defaults:", e.message);
  startServer();
  startBot();
});
