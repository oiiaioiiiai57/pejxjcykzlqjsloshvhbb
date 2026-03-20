import { readJson, writeJson } from "./github.js";

export const CONFIG_FILE = "guild_config.json";

const DEFAULT_GUILDS = {
  "1479080681572274320": {
    name:             "Serveur 1",
    freeChannel:      "1479204587104895060",
    premiumChannel:   "1479080682616520718",
    boosterChannel:   "1479080682616520717",
    extremeChannel:   "1479080682616520717",
    ticketCategory:   "1484446765900894218",
    logChannel:       "1479239531499880628",
    staffRole:        "1479080681983316004",
    helperRole:       "1479080681983316008",
    addvRole:         "1479080681996030042",
    modRoles:         ["1479080681983316006","1479080681983316007","1479080681996030042","1479080681996030043"],
    staffRoleId:      "1479080681983316007",
    vouchTiers: [
      { threshold: 40,  roles: ["1479080681983316005","1479080681983316008"] },
      { threshold: 60,  roles: ["1479080681983316006"] },
      { threshold: 100, roles: ["1479080681983316007"] },
    ],
    tierRoles: {
      free:    ["1479080681970729122","1479080681983316001"],
      premium: ["1479080681983316003"],
      booster: ["1479080681983316002"],
      extreme: ["1479080681983316007"],
    },
  },
  "1479133088524009514": {
    name:             "Serveur 2",
    freeChannel:      "1482070977222410260",
    premiumChannel:   "1482070967923773583",
    boosterChannel:   "1482070966354972682",
    extremeChannel:   "1482070966354972682",
    ticketCategory:   "1482070942766071888",
    logChannel:       "1482070978938015867",
    staffRole:        "1482070883525722123",
    helperRole:       "1482070883525722123",
    addvRole:         "1482070883525722123",
    modRoles:         ["1482070883525722123"],
    staffRoleId:      "1482070883525722123",
    vouchTiers: [
      { threshold: 40,  roles: ["1482070899023806574"] },
      { threshold: 60,  roles: ["1482070887497863228"] },
      { threshold: 100, roles: ["1482070888479326219"] },
    ],
    tierRoles: {
      free:    ["1482070899023806574","1482070889121054892"],
      premium: ["1482070887497863228"],
      booster: ["1482070888479326219"],
      extreme: ["1482070883525722123"],
    },
  },
};

// On exporte un objet FIXE — on le mute toujours en place (Object.assign)
// pour que tous les imports voient toujours le même objet référence
export const GUILDS = { ...DEFAULT_GUILDS };

export async function loadGuildConfig() {
  try {
    const saved = await readJson(CONFIG_FILE, null);
    if (saved && Object.keys(saved).length > 0) {
      // Vider puis remplir EN PLACE — toutes les références restent valides
      Object.keys(GUILDS).forEach(k => delete GUILDS[k]);
      Object.assign(GUILDS, saved);
      console.log(`✅ Guild config loaded from GitHub (${Object.keys(GUILDS).length} guilds)`);
    } else {
      await writeJson(CONFIG_FILE, DEFAULT_GUILDS);
      Object.keys(GUILDS).forEach(k => delete GUILDS[k]);
      Object.assign(GUILDS, DEFAULT_GUILDS);
      console.log("✅ Default guild config saved to GitHub");
    }
  } catch (e) {
    console.warn("⚠️  Could not load guild config, using defaults:", e.message);
    Object.keys(GUILDS).forEach(k => delete GUILDS[k]);
    Object.assign(GUILDS, DEFAULT_GUILDS);
  }
}

export async function saveGuildConfig() {
  await writeJson(CONFIG_FILE, GUILDS);
}

export function getGuild(guildId) {
  return GUILDS[String(guildId)] || null;
}

// free=1/h  premium=3/h  booster=5/h  extreme=20/h  staff=∞
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
  : (process.env.SITE_URL || "https://pejxjcykzlqjsloshvhbb-production.up.railway.app");

export const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `${SITE}/auth/callback`;
export const BOT_SECRET = process.env.BOT_SECRET || "genbotinternal";
