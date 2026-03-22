import { readJson, writeJson } from "./github.js";

export const CONFIG_FILE = "guild_config.json";

const DEFAULT_GUILDS = {
  "1484239591967035585": {
    name:           "Serveur Principal",
    freeChannel:    "1484271275366158447",
    premiumChannel: "1484278388645560601",
    boosterChannel: "1484278702069125221",
    extremeChannel: "1484278980113596508",
    ticketCategory: "1484446765900894218",
    logChannel:     "1484290245758419079",
    staffRole:      "1484240623442722917",
    helperRole:     "1484637184907673660",
    addvRole:       "1484241167636758558",
    modRoles:       ["1484240623442722917","1484241028310368397","1484241167636758558"],
    staffRoleId:    "1484241028310368397",
    vouchTiers: [
      { threshold: 25,  roles: ["1484241028310368397"] },
      { threshold: 50,  roles: ["1484240883934167120"] },
      { threshold: 75,  roles: ["1484241304459415632"] },
      { threshold: 100, roles: [], message: "Crée un ticket pour obtenir ton rôle !" },
    ],
    tierRoles: {
      free:    ["1484272629216051473"],
      premium: ["1484272227481550960"],
      booster: ["1484272158807953408"],
      extreme: ["1484241028310368397"],
    },
  },
};

export const GUILDS = { ...DEFAULT_GUILDS };

let _configLoaded = false;

export async function loadGuildConfig() {
  if (_configLoaded) return;
  _configLoaded = true;
  Object.keys(GUILDS).forEach(k => delete GUILDS[k]);
  Object.assign(GUILDS, DEFAULT_GUILDS);
  console.log("✅ Guild config loaded");
}

export function getGuild(guildId) {
  return GUILDS[String(guildId)] || null;
}

export const COOLDOWN_LIMITS = {
  free:    { max: 1,  period: 3600 },
  premium: { max: 3,  period: 3600 },
  booster: { max: 5,  period: 3600 },
  extreme: { max: 20, period: 3600 },
};

export const TIERS = ["free","premium","booster","extreme"];

export const TIER_META = {
  free:    { emoji: "🟢", color: 0x57F287, label: "Free",    hex: "#57F287" },
  premium: { emoji: "🟣", color: 0xA855F7, label: "Premium", hex: "#a855f7" },
  booster: { emoji: "🔵", color: 0x00BFFF, label: "Booster", hex: "#00bfff" },
  extreme: { emoji: "🔴", color: 0xFF4757, label: "Extrême", hex: "#ff4757" },
};

export const FILES = {
  pending:   "pending.json",
  stats:     "stats.json",
  cooldowns: "cooldowns.json",
  sendCd:    "send_cooldown.json",
  vouches:   "vouches.json",
  sessions:  "web_sessions.json",
  genlog:    "web_genlog.json",
  tickets:   "web_tickets.json",
  giveaways: "giveaways.json",
};

export const ACCOUNTS_DIR = "accounts";

export const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID || "1481723412580929536";
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

export const SITE = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.SITE_URL || "https://web-production-adfea.up.railway.app");

export const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `${SITE}/auth/callback`;
export const BOT_SECRET = process.env.BOT_SECRET || "genbotinternal";
