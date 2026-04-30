import { readJson, writeJson } from "./github.js";

export const CONFIG_FILE = "guild_config.json";

const DEFAULT_GUILDS = {
  "1484239591967035585": {
    name:           "Server 1",
    folder:         "server1",
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
      { threshold: 100, roles: [], message: "Create a ticket to get your role!" },
    ],
    tierRoles: {
      free:    ["1484272629216051473"],
      premium: ["1484272227481550960"],
      booster: ["1484272158807953408"],
      extreme: ["1484241028310368397"],
    },
  },
  "1479080681572274320": {
    name:           "Server 2",
    folder:         "server2",
    freeChannel:    "1479204587104895060",
    premiumChannel: "1479080682616520718",
    boosterChannel: "1487470615777509527",
    extremeChannel: "1479080682616520717",
    ticketCategory: "1479080682784555134",
    logChannel:     "1479239531499880628",
    staffRole:      "1479080681983316008",
    helperRole:     "1479080681983316004",
    addvRole:       "1479080681983316007",
    modRoles:       ["1479080681983316004"],
    staffRoleId:    "1479080681983316005",
    // Verify system
    verifyRole:      "1479080681996030042",
    notVerifiedRole: "1479234907153629214",
    verifiedRole:    "1479080681572274323",
    memberRole:      "1479080681970729122",
    // Bio/status link role
    bioLinkRole:     "1479080681983316001",
    bioLink:         "discord.gg/zC85ms8btn",
    vouchTiers: [
      { threshold: 30,  roles: ["1479080681983316005"] },
      { threshold: 60,  roles: ["1479080681983316006"] },
      { threshold: 100, roles: ["1479080681983316007"] },
    ],
    tierRoles: {
      free:    ["1479080681983316001"],
      premium: ["1479080681983316003"],
      booster: ["1487475888072163369"],
      extreme: ["1479080681983316002"],
    },
  },
};

// Single source of truth — code wins over GitHub
export const GUILDS = { ...DEFAULT_GUILDS };

let _configLoaded = false;

export async function loadGuildConfig() {
  if (_configLoaded) return;
  _configLoaded = true;
  // Clear current and load from GitHub
  Object.keys(GUILDS).forEach(k => delete GUILDS[k]);
  try {
    const saved = await readJson(CONFIG_FILE);
    if (saved && Object.keys(saved).length > 0) {
      Object.assign(GUILDS, saved);
      console.log(`✅ Guild config loaded from GitHub: ${Object.keys(GUILDS).join(", ")}`);
    } else {
      // Use DEFAULT_GUILDS and also add any guilds the bot is currently in
      Object.assign(GUILDS, DEFAULT_GUILDS);
      console.log(`✅ Guild config loaded (defaults): ${Object.keys(GUILDS).join(", ")}`);
    }
  } catch(e) {
    Object.assign(GUILDS, DEFAULT_GUILDS);
    console.log(`⚠️ Guild config load failed, using defaults: ${e.message}`);
  }
}

export function getGuild(guildId) {
  return GUILDS[String(guildId)] || null;
}

// Sync GUILDS with actual bot guilds (call on ClientReady)
export async function syncGuilds(botGuilds) {
  let changed = false;
  for (const [guildId, guild] of botGuilds) {
    if (!GUILDS[String(guildId)]) {
      console.log(`🔄 Syncing guild: ${guild.name} (${guildId})`);
      GUILDS[String(guildId)] = {
        name: guild.name,
        folder: `server${Object.keys(GUILDS).length + 1}`,
        freeChannel: null,
        premiumChannel: null,
        boosterChannel: null,
        extremeChannel: null,
        ticketCategory: null,
        logChannel: null,
        staffRole: null,
        helperRole: null,
        addvRole: null,
        modRoles: [],
        staffRoleId: null,
        tierRoles: { free: [], premium: [], booster: [], extreme: [] },
      };
      changed = true;
    }
  }
  if (changed) {
    try {
      await writeJson(CONFIG_FILE, GUILDS);
      console.log(`✅ Guild config synced and saved`);
    } catch(e) {
      console.error(`Failed to save synced guilds: ${e.message}`);
    }
  }
}

// free=1/h  premium=3/h  booster=5/h  extreme=20/h  staff=∞
export const COOLDOWN_LIMITS = {
  free:    { max: 1,  period: 900 },  // 15 minutes
  premium: { max: 3,  period: 3600 },
  booster: { max: 5,  period: 3600 },
  extreme: { max: 20, period: 3600 },
  paid:    { max: 5,  period: 3600 },
};

export const TIERS = ["free","premium","booster","extreme"];

export const TIER_META = {
  free:    { emoji: "🟢", color: 0x57F287, label: "Free",    hex: "#57F287" },
  premium: { emoji: "🟣", color: 0xA855F7, label: "Premium", hex: "#a855f7" },
  booster: { emoji: "🔵", color: 0x00BFFF, label: "Booster", hex: "#00bfff" },
  extreme: { emoji: "🔴", color: 0xFF4757, label: "Extreme",  hex: "#ff4757" },
  paid:    { emoji: "🟡", color: 0xFFD700, label: "Paid",     hex: "#ffd700" },
};

export const FILES = {
  pending:      "pending.json",
  stats:        "stats.json",
  cooldowns:     "cooldowns.json",
  sendCd:       "send_cooldown.json",
  vouches:       "vouches.json",
  sessions:      "web_sessions.json",
  genlog:       "web_genlog.json",
  tickets:       "web_tickets.json",
  giveaways:     "giveaways.json",
  feedback:      "feedback.json",
  backups:       "backups.json",
  announcements: "announcements.json",
  categories:    "categories.json",
  searchlog:     "searchlog.json",
  rateLimits:    "rate_limits.json",
};

export const ACCOUNTS_DIR = "accounts";

// Get the accounts path for a specific guild
export function getAccountsDir(guildId) {
  const cfg = getGuild(guildId);
  const folder = cfg?.folder || "server1";
  return `${ACCOUNTS_DIR}/${folder}`;
}

// Service categories (can be overridden per guild)
export const DEFAULT_CATEGORIES = {
  streaming: { name: { en: "Streaming", fr: "Streaming" }, emoji: "🎬", services: ["Netflix", "Disney+", "Hulu", "HBO Max", "Prime Video", "Crunchyroll"] },
  gaming:    { name: { en: "Gaming",    fr: "Jeux Vidéo" },   emoji: "🎮", services: ["Xbox", "PlayStation", "Steam", "Minecraft", "Epic Games"] },
  music:     { name: { en: "Music",     fr: "Musique" },       emoji: "🎵", services: ["Spotify", "Apple Music", "YouTube Music", "Tidal"] },
  software:  { name: { en: "Software",  fr: "Logiciels" },     emoji: "💻", services: ["Adobe", "Microsoft Office", "Antivirus"] },
  other:     { name: { en: "Other",     fr: "Autre" },         emoji: "📦", services: [] },
};

// Rate limiting per user (enhanced)
export const RATE_LIMITS = {
  perUser: {
    free:    { max: 10, period: 3600000 },  // 10 per hour
    premium: { max: 20, period: 3600000 },  // 20 per hour
    booster: { max: 30, period: 3600000 },  // 30 per hour
    extreme: { max: 50, period: 3600000 },  // 50 per hour
  },
  webGen:   { max: 5,  period: 60000 },    // 5 per minute from web
};

// Stock alert thresholds
export const STOCK_ALERT_THRESHOLD = 5; // Alert when stock <= 5
export const LOW_STOCK_THRESHOLD   = 3; // Very low stock

// Auto-backup config
export const BACKUP_CONFIG = {
  enabled: true,
  intervalMs: 6 * 60 * 60 * 1000, // 6 hours
  keepLast: 10, // Keep last 10 backups
  compress: true,
};

// Feedback config
export const FEEDBACK_CONFIG = {
  enabled: true,
  maxRating: 5,
  requireFeedback: false,
};

export const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID || "1481723412580929536";
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

export const SITE = process.env.RENDER_EXTERNAL_URL
  ? process.env.RENDER_EXTERNAL_URL
  : (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : (process.env.SITE_URL || "https://web-production-06585.up.railway.app"));

export const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `${SITE}/auth/callback`;
export const BOT_SECRET = process.env.BOT_SECRET || "genbotinternal";
