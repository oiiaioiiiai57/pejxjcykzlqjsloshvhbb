import {
  Client, GatewayIntentBits, Partials, Events,
  SlashCommandBuilder, EmbedBuilder, PermissionsBitField,
  REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { readJson, writeJson, readLines, writeLines, listDir } from "./github.js";
import { GUILDS, FILES, ACCOUNTS_DIR, BOT_SECRET, TIERS, TIER_META,
         COOLDOWN_LIMITS, DEFAULT_CATEGORIES, RATE_LIMITS, STOCK_ALERT_THRESHOLD,
         LOW_STOCK_THRESHOLD, BACKUP_CONFIG, FEEDBACK_CONFIG, loadGuildConfig, syncGuilds, getGuild, getAccountsDir } from "./config.js";
import { channelToTicket } from "./server.js";
import { messages, t, getUserLang } from "./i18n.js";
import crypto from "crypto";
import http from "http";
import fs from "fs/promises";

const BACKEND = process.env.BACKEND_URL || "https://web-production-06585.up.railway.app";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// ── COLOURS & HELPERS ─────────────────────────────────────────
const C = { success:0x57F287, error:0xED4245, warn:0xFEE75C, info:0x5865F2, log:0x2B2D31, purple:0xA855F7, blue:0x00BFFF, red:0xFF4757 };

const ok   = (t,d) => new EmbedBuilder().setTitle(`✅  ${t}`).setDescription(d||null).setColor(C.success).setFooter({text:"Gen Bot • /help for commands"}).setTimestamp();
const err  = (t,d) => new EmbedBuilder().setTitle(`❌  ${t}`).setDescription(d||null).setColor(C.error).setFooter({text:"Gen Bot • /help for commands"}).setTimestamp();
const warn = (t,d) => new EmbedBuilder().setTitle(`⚠️  ${t}`).setDescription(d||null).setColor(C.warn).setFooter({text:"Gen Bot • /help for commands"}).setTimestamp();
const log  = (t,d) => new EmbedBuilder().setTitle(t).setDescription(d||null).setColor(C.log).setTimestamp().setFooter({text:"Gen Bot • Log"});
const fancy = (t,d,color) => new EmbedBuilder().setTitle(t).setDescription(d||null).setColor(color||C.info).setFooter({text:"Gen Bot"}).setTimestamp();

// Enhanced logging
function enhancedLog(guild, action, details, color = C.log) {
  const embed = fancy(`📝 ${action}`, details, color);
  return sendLog(guild, embed);
}

// ── STOCK ALERTS ────────────────────────────────────────────
async function checkAndAlertStock(guild, tier, service, remaining) {
  if (remaining <= LOW_STOCK_THRESHOLD) {
    const cfg = getCfg(guild.id);
    if (!cfg) return;
    const meta = TIER_META[tier] || TIER_META.free;
    const embed = new EmbedBuilder()
      .setTitle("⚠️  LOW STOCK ALERT")
      .setColor(C.red)
      .setDescription(`**${service}** (${meta.emoji} ${meta.label}) is running low!`)
      .addFields(
        { name: "📦 Remaining", value: `**${remaining}** accounts left!`, inline: true },
        { name: "🏷️ Tier", value: `${meta.emoji} ${meta.label}`, inline: true },
        { name: "🔧 Action Needed", value: "Please restock soon!", inline: false }
      )
      .setFooter({ text: "Gen Bot • Stock Alert System" })
      .setTimestamp();
    await sendLog(guild, embed);

    // Send DM to staff
    try {
      const staffRole = guild.roles.cache.get(cfg.staffRole);
      if (staffRole) {
        const members = staffRole.members;
        for (const [, member] of members) {
          await member.send({ embeds: [embed] }).catch(() => {});
        }
      }
    } catch (e) { console.error("Stock alert DM error:", e.message); }
  }
}

// ── FEEDBACK SYSTEM ─────────────────────────────────────────
async function saveFeedback(userId, rating, comment = "", service = "", tier = "") {
  const feedback = await readJson(FILES.feedback);
  if (!feedback[userId]) feedback[userId] = [];
  feedback[userId].push({
    rating,
    comment,
    service,
    tier,
    date: new Date().toISOString(),
  });
  await writeJson(FILES.feedback, feedback);
}

async function getFeedbackStats() {
  const feedback = await readJson(FILES.feedback);
  let totalRating = 0, count = 0;
  const serviceRatings = {};

  for (const userFeedback of Object.values(feedback)) {
    for (const fb of userFeedback) {
      totalRating += fb.rating;
      count++;
      if (fb.service) {
        if (!serviceRatings[fb.service]) serviceRatings[fb.service] = { total: 0, count: 0 };
        serviceRatings[fb.service].total += fb.rating;
        serviceRatings[fb.service].count++;
      }
    }
  }

  return {
    average: count > 0 ? (totalRating / count).toFixed(2) : 0,
    total: count,
    serviceRatings,
  };
}

// ── AUTO-BACKUP SYSTEM ──────────────────────────────────────
let backupInterval = null;

async function performBackup() {
  try {
    console.log("🔄 Starting automatic backup...");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupData = {
      timestamp,
      files: {},
    };

    // Backup all JSON files
    for (const [key, filename] of Object.entries(FILES)) {
      try {
        const data = await readJson(filename);
        backupData.files[key] = data;
      } catch (e) {
        console.error(`Backup error for ${filename}:`, e.message);
      }
    }

    // Backup account directories
    const accountsBackup = {};
    for (const guildId of Object.keys(GUILDS)) {
      const acDir = getAccountsDir(guildId);
      for (const tier of TIERS) {
        try {
          const files = await listDir(`${acDir}/${tier}`);
          accountsBackup[`${guildId}/${tier}`] = {};
          for (const f of files) {
            if (!f.name.endsWith(".txt")) continue;
            const lines = await readLines(f.path);
            accountsBackup[`${guildId}/${tier}`][f.name] = lines;
          }
        } catch (_) {}
      }
    }
    backupData.accounts = accountsBackup;

    // Save backup
    const backups = await readJson(FILES.backups);
    if (!Array.isArray(backups)) backups = [];
    backups.push(backupData);

    // Keep only last N backups
    while (backups.length > BACKUP_CONFIG.keepLast) backups.shift();

    await writeJson(FILES.backups, backups);
    console.log(`✅ Backup completed: ${timestamp}`);

    // Log to Discord
    for (const guildId of Object.keys(GUILDS)) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        await sendLog(guild, fancy("🔄 Auto-Backup", `Backup completed at ${new Date().toLocaleString()}`, C.success));
      }
    }
  } catch (e) {
    console.error("Backup failed:", e.message);
  }
}

function startBackupScheduler() {
  if (backupInterval) clearInterval(backupInterval);
  backupInterval = setInterval(performBackup, BACKUP_CONFIG.intervalMs);
  console.log(`✅ Backup scheduler started (every ${BACKUP_CONFIG.intervalMs / 1000 / 60} minutes)`);
}

// ── RATE LIMITING PER USER ─────────────────────────────────
const userRateLimits = new Map();

function checkRateLimit(userId, type = "perUser") {
  const now = Date.now();
  const config = RATE_LIMITS[type] || RATE_LIMITS.perUser;
  const { max, period } = config;

  if (!userRateLimits.has(userId)) userRateLimits.set(userId, {});
  const userLimits = userRateLimits.get(userId);

  if (!userLimits[type]) userLimits[type] = [];
  const requests = userLimits[type].filter(ts => now - ts < period);
  userLimits[type] = requests;

  if (requests.length >= max) {
    const wait = Math.ceil((period - (now - requests[0])) / 1000);
    return { allowed: false, wait };
  }

  requests.push(now);
  return { allowed: true };
}

// ── SERVICE CATEGORIES ──────────────────────────────────────
function getServiceCategory(serviceName) {
  const svc = serviceName.toLowerCase();
  for (const [key, cat] of Object.entries(DEFAULT_CATEGORIES)) {
    if (cat.services.some(s => s.toLowerCase() === svc)) return key;
  }
  return "other";
}

function getServicesByCategory(category) {
  return DEFAULT_CATEGORIES[category]?.services || [];
}

async function getCategorizedStock(guildId, tier = null) {
  const acDir = getAccountsDir(guildId);
  const tiers = tier ? [tier] : TIERS;
  const result = {};

  for (const t of tiers) {
    const files = await listDir(`${acDir}/${t}`);
    for (const f of files) {
      if (!f.name.endsWith(".txt")) continue;
      const service = f.name.replace(".txt", "");
      const category = getServiceCategory(service);
      if (!result[category]) result[category] = {};
      if (!result[category][t]) result[category][t] = [];
      const count = (await readLines(f.path)).length;
      if (count > 0) {
        result[category][t].push({ name: service, count });
      }
    }
  }

  return result;
}

// ── USER PROFILES (Enhanced) ────────────────────────────────
async function getUserProfile(userId, guildId) {
  const stats = await readJson(FILES.stats);
  const genlog = await readJson(FILES.genlog);
  const vouches = await getVouches(userId);

  const total = typeof stats[userId] === "number" ? stats[userId] : 0;
  const tierData = stats[`${userId}_tiers`] || {};
  const history = genlog[userId] || [];

  // Calculate rate limit info
  const now = Date.now();
  const rateInfo = {};
  for (const tier of TIERS) {
    const limit = RATE_LIMITS.perUser;
    const used = (userRateLimits.get(userId)?.perUser || []).filter(ts => now - ts < limit.period).length;
    rateInfo[tier] = { used, max: limit.max, remaining: limit.max - used };
  }

  return { userId, total, vouches, tierData, history, rateInfo };
}

// ── ANNOUNCEMENT SYSTEM ────────────────────────────────────
async function announceToAll(guildId, message, sendDM = true) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error("Guild not found");

  let sentCount = 0;

  if (sendDM) {
    // Get all members with generation history
    const stats = await readJson(FILES.stats);
    const userIds = Object.keys(stats).filter(k => /^\d+$/.test(k));

    for (const userId of userIds) {
      try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
          await member.send({ embeds: [fancy("📢 Announcement", message, C.info)] }).catch(() => {});
          sentCount++;
        }
      } catch (_) {}
    }
  } else {
    // Send to staff channel
    const cfg = getCfg(guildId);
    if (cfg?.logChannel) {
      const channel = guild.channels.cache.get(cfg.logChannel);
      if (channel) {
        await channel.send({ embeds: [fancy("📢 Announcement", message, C.info)] });
        sentCount = 1;
      }
    }
  }

  return sentCount;
}

// ── SEARCH ACCOUNTS ─────────────────────────────────────────
async function searchAccounts(guildId, query, tier = null) {
  const acDir = getAccountsDir(guildId);
  const tiers = tier ? [tier] : TIERS;
  const results = [];

  for (const t of tiers) {
    const files = await listDir(`${acDir}/${t}`);
    for (const f of files) {
      if (!f.name.endsWith(".txt")) continue;
      const service = f.name.replace(".txt", "");
      if (service.toLowerCase().includes(query.toLowerCase())) {
        const lines = await readLines(f.path);
        results.push({ tier: t, service, count: lines.length, lines: lines.slice(0, 5) }); // Show first 5 accounts
      }
    }
  }

  return results;
}

// ── GEN COOLDOWN DISPLAY ──────────────────────────────────
function formatCooldown(ms) {
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function getCooldownDisplay(userId) {
  const now = Date.now();
  const displays = [];

  for (const tier of TIERS) {
    const limit = COOLDOWN_LIMITS[tier];
    if (!limit) continue;

    const used = (botCooldowns.get(`${userId}:${tier}`) || []).filter(ts => now - ts < limit.period * 1000);
    if (used.length > 0) {
      const wait = limit.period * 1000 - (now - used[0]);
      if (wait > 0) {
        displays.push({ tier, wait, remaining: limit.max - used.length });
      }
    }
  }

  return displays;
}

// ── AUTO RESTOCK NOTIFICATION ───────────────────────────────
async function notifyRestock(guild, tier, service, amount) {
  const embed = new EmbedBuilder()
    .setTitle("📦  Restock Notification")
    .setColor(TIER_META[tier]?.color || C.success)
    .setDescription(`**${service}** has been restocked!`)
    .addFields(
      { name: "📦 Amount", value: `**+${amount}** accounts added`, inline: true },
      { name: "🏷️ Tier", value: `${TIER_META[tier]?.emoji || "❓"} ${TIER_META[tier]?.label || tier}`, inline: true },
    )
    .setFooter({ text: "Gen Bot • Stock Management" })
    .setTimestamp();

  await sendLog(guild, embed);

  // Send to stock channel if configured
  const cfg = getCfg(guild.id);
  if (cfg?.stockChannel) {
    const channel = guild.channels.cache.get(cfg.stockChannel);
    if (channel) await channel.send({ embeds: [embed] }).catch(() => {});
  }
}

function getCfg(guildId) {
  const cfg = getGuild(guildId);
  if (!cfg) {
    console.warn(`[getCfg] Guild ${guildId} not in GUILDS. Available: ${Object.keys(GUILDS).join(",")}`);
  }
  return cfg;
}

// Build DM payload — returns { embeds, files? }
async function buildAccountDM(account, service, tier) {
  const meta = TIER_META[tier] || TIER_META.free;
  const embed = new EmbedBuilder()
    .setTitle("📦  Your Account is Ready!")
    .setColor(meta.color)
    .addFields(
      {name:"📦 Service", value:`**${service}**`, inline:true},
      {name:"🏷️ Tier",   value:`${meta.emoji} **${meta.label}**`, inline:true}
    )
    .setFooter({text:"Gen Bot • Do not share this!"})
    .setTimestamp();

  if (account.startsWith("FILE:")) {
    // Uploaded via ZIP — deliver as .txt file attachment
    const { AttachmentBuilder } = await import("discord.js");
    const content = Buffer.from(account.slice(5), "base64");
    const file = new AttachmentBuilder(content, {name:`${service}.txt`});
    embed.setDescription("Your account is attached as a file below.");
    return { embeds:[embed], files:[file] };
  } else {
    // Uploaded as plain .txt line — show in embed
    embed.setDescription(`\`\`\`${account}\`\`\``);
    return { embeds:[embed] };
  }
}
function getServerTiers(guildId) {
  // Both servers now have free/premium/booster/extreme
  return TIERS;
}
function isMod(m)    { const c=getCfg(m.guild.id); return m.guild.ownerId === m.id || m.permissions.has(PermissionsBitField.Flags.Administrator) || c?.modRoles.some(r=>m.roles.cache.has(r))||false; }
function isHelper(m) { const c=getCfg(m.guild.id); return m.roles.cache.has(c?.helperRole)||false; }
function isStaff(m)  { return isMod(m)||isHelper(m); }
function hasAddv(m)  { const c=getCfg(m.guild.id); return m.roles.cache.has(c?.addvRole)||false; }

async function sendLog(guild, embed) {
  const cfg = getCfg(guild.id);
  if (!cfg) return;
  const ch = guild.channels.cache.get(cfg.logChannel);
  if (ch) await ch.send({ embeds:[embed] }).catch(console.error);
}

// Bot cooldowns (in-memory, reset on restart — fine since Railway restarts clear cooldowns anyway)
const botCooldowns = new Map();
function checkBotCooldown(userId, tier) {
  if (!COOLDOWN_LIMITS[tier]) return { ok:true };
  const { max, period } = COOLDOWN_LIMITS[tier];
  const now = Date.now(); const key = `${userId}:${tier}`;
  const bucket = (botCooldowns.get(key)||[]).filter(ts => now-ts < period*1000);
  if (bucket.length >= max) return { ok:false, wait:Math.ceil((period*1000-(now-bucket[0]))/1000) };
  bucket.push(now); botCooldowns.set(key, bucket); return { ok:true };
}

// Check all stock for low alerts on startup
async function checkAllStockAlerts() {
  console.log("🔍 Checking stock levels...");
  for (const guildId of Object.keys(GUILDS)) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    for (const tier of TIERS) {
      try {
        const acDir = getAccountsDir(guildId);
        const files = await listDir(`${acDir}/${tier}`);
        for (const f of files) {
          if (!f.name.endsWith(".txt")) continue;
          const count = (await readLines(f.path)).length;
          if (count <= STOCK_ALERT_THRESHOLD) {
            const service = f.name.replace(".txt","");
            await checkAndAlertStock(guild, tier, service, count);
          }
        }
      } catch (_) {}
    }
  }
}

function capitalize(s) { return s.charAt(0).toUpperCase()+s.slice(1).toLowerCase(); }
async function getVouches(uid) { return (await readJson(FILES.vouches))[String(uid)]||0; }
async function addVouch(uid, n=1) {
  const d=await readJson(FILES.vouches); d[String(uid)]=(d[String(uid)]||0)+n;
  await writeJson(FILES.vouches,d); return d[String(uid)];
}
async function checkAndPromote(guild, member, vouches) {
  const cfg=getCfg(guild.id); if (!cfg) return;
  for (const vt of cfg.vouchTiers) {
    const { threshold, roles, message } = vt;
    if (vouches >= threshold) {
      // Cas spécial : message ticket au lieu de rôle auto
      if (message && (!roles || roles.length === 0)) {
        // Vérifier si on vient exactement d'atteindre ce seuil (±1)
        const prev = vouches - 1;
        const wasAlready = cfg.vouchTiers.some(v => v.threshold === threshold && prev >= threshold);
        if (!wasAlready || vouches === threshold) {
          const logCh = guild.channels.cache.get(cfg.logChannel);
          if (logCh) await logCh.send({
            embeds: [new EmbedBuilder()
              .setTitle("🏆  Congratulations!")
              .setDescription(`${member} reached **${threshold} vouches**!\n\n> ${message}`)
              .setColor(0xFFD166).setTimestamp()]
          }).catch(console.error);
        }
        continue;
      }
      const newly=[];
      for (const rid of (roles||[])) {
        if (!member.roles.cache.has(rid)) { await member.roles.add(rid).catch(console.error); newly.push(rid); }
      }
      if (newly.length) {
        const l=log("🎉  Promotion",`${member} → ${newly.map(r=>`<@&${r}>`).join(" ")} with **${vouches} vouches**!`);
        l.setColor(0xA855F7); await sendLog(guild,l);
      }
    }
  }
}

async function notifyBackend(path, body={}) {
  return fetch(`${BACKEND}${path}`,{
    method:"POST", headers:{"Content-Type":"application/json","X-Bot-Secret":BOT_SECRET},
    body:JSON.stringify(body),
  }).catch(e=>console.error(`Backend ${path}:`,e.message));
}

// ── GIVEAWAY STATE ────────────────────────────────────────────
// { messageId: { channelId, guildId, service, tier, account, endsAt, ended } }
const activeGiveaways = new Map();

async function loadGiveaways() {
  const saved = await readJson(FILES.giveaways);
  for (const [mid, gw] of Object.entries(saved)) {
    if (!gw.ended) activeGiveaways.set(mid, gw);
  }
  // Schedule remaining timers
  for (const [mid, gw] of activeGiveaways) {
    const msLeft = new Date(gw.endsAt).getTime() - Date.now();
    if (msLeft > 0) setTimeout(() => endGiveaway(mid), msLeft);
    else endGiveaway(mid);
  }
  console.log(`✅ Loaded ${activeGiveaways.size} active giveaways`);
}

async function saveGiveaways() {
  const data = {};
  for (const [mid, gw] of activeGiveaways) data[mid] = gw;
  await writeJson(FILES.giveaways, data);
}

async function endGiveaway(messageId) {
  const gw = activeGiveaways.get(messageId);
  if (!gw || gw.ended) return;
  gw.ended = true;
  await saveGiveaways();

  try {
    const guild   = client.guilds.cache.get(gw.guildId);
    if (!guild) return;
    const channel = guild.channels.cache.get(gw.channelId);
    if (!channel) return;
    const message = await channel.messages.fetch(messageId).catch(()=>null);
    if (!message) return;

    // Fetch 🎉 reactors
    const reaction = message.reactions.cache.get("🎉");
    if (!reaction) {
      await channel.send({ embeds:[err("Giveaway Ended","No participants — no winner.")] });
      return;
    }
    const users = await reaction.users.fetch();
    const eligible = users.filter(u => !u.bot);
    if (!eligible.size) {
      await channel.send({ embeds:[err("Giveaway Ended","No valid participants.")] });
      return;
    }

    const winner = eligible.random();
    const meta   = TIER_META[gw.tier] || TIER_META.free;

    // Send account to winner via DM
    const dmEmbed = new EmbedBuilder()
      .setTitle("🎉  You Won a Giveaway!")
      .setDescription(`Congratulations! Here is your **${gw.service}** account:`)
      .setColor(meta.color)
      .addFields({ name:"🔐 Account", value:`\`\`\`${gw.account}\`\`\`` })
      .setFooter({ text:"Gen Bot • Do not share this account!" })
      .setTimestamp();

    await winner.send({ embeds:[dmEmbed] }).catch(async () => {
      await channel.send(`${winner} — your DMs are closed, please contact a staff member to receive your account.`);
    });

    // Announce winner
    const winEmbed = new EmbedBuilder()
      .setTitle("🎉  Giveaway Ended!")
      .setColor(meta.color)
      .addFields(
        { name:"🏆 Winner",  value:winner.toString(),     inline:true },
        { name:"📦 Service",  value:`**${gw.service}**`,   inline:true },
        { name:"🏷️ Tier",    value:`${meta.emoji} **${meta.label}**`, inline:true },
      )
      .setDescription("The account has been sent to the winner via DM!")
      .setTimestamp();

    await channel.send({ content:`🎉 Congratulations ${winner}!`, embeds:[winEmbed] });

    // Update original message
    await message.edit({ embeds:[
      new EmbedBuilder()
        .setTitle("🎁  Giveaway — ENDED")
        .setColor(0x2B2D31)
        .addFields(
          { name:"📦 Service",  value:`**${gw.service}**`,           inline:true },
          { name:"🏷️ Tier",    value:`${meta.emoji} ${meta.label}`, inline:true },
          { name:"🏆 Winner", value:winner.toString(),              inline:true },
        )
        .setFooter({ text:"Giveaway Ended" })
        .setTimestamp()
    ]}).catch(()=>{});

    // Log
    const cfg = getCfg(gw.guildId);
    if (cfg) {
      const l = log("🎁 Giveaway Ended",`Winner: ${winner} • **${gw.service}** (${gw.tier})`);
      l.setColor(meta.color);
      await sendLog(guild, l);
    }
  } catch(e) { console.error("endGiveaway error:", e); }
}

// ── SLASH COMMANDS ────────────────────────────────────────────
const TIER_CHOICES = TIERS.map(t => ({ name:`${TIER_META[t].emoji} ${TIER_META[t].label}`, value:t }));

// Category choices
const CATEGORY_CHOICES = Object.entries(DEFAULT_CATEGORIES).map(([key, cat]) =>
  ({ name: `${cat.emoji} ${cat.name.en}`, value: key })
);

const commands = [
  new SlashCommandBuilder().setName("gen").setDescription("Generate an account")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service name (e.g. Netflix)").setRequired(true))
    .addStringOption(o=>o.setName("category").setDescription("Category").addChoices(...CATEGORY_CHOICES)),

  new SlashCommandBuilder().setName("redeem").setDescription("[Staff] Validate a ticket")
    .addStringOption(o=>o.setName("code").setDescription("Ticket claim code").setRequired(true)),

  new SlashCommandBuilder().setName("close").setDescription("[Staff] Close a ticket"),

  new SlashCommandBuilder().setName("giveaway").setDescription("[Staff] Start a giveaway")
    .addStringOption(o=>o.setName("service").setDescription("Service name (e.g. Netflix)").setRequired(true))
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addIntegerOption(o=>o.setName("duree").setDescription("Duration in minutes").setRequired(true).setMinValue(1).setMaxValue(10080)),

  new SlashCommandBuilder().setName("addv").setDescription("[Admin] Add vouches to a member")
    .addUserOption(o=>o.setName("member").setDescription("Target").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("rall").setDescription("[Admin] Remove all stock for a service")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service name").setRequired(true)),

  new SlashCommandBuilder().setName("web").setDescription("Get the website link"),

  new SlashCommandBuilder().setName("xbox").setDescription("Look up an Xbox gamertag profile")
    .addStringOption(o=>o.setName("gamertag").setDescription("Xbox Gamertag").setRequired(true)),

  new SlashCommandBuilder().setName("rvoutch").setDescription("[Admin] Remove vouches from a member")
    .addUserOption(o=>o.setName("member").setDescription("Target").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("promote").setDescription("View vouch progress")
    .addUserOption(o=>o.setName("member").setDescription("Target (empty = yourself)")),

  new SlashCommandBuilder().setName("stock").setDescription("View available stock")
    .addStringOption(o=>o.setName("tier").setDescription("Filter by tier").addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("category").setDescription("Filter by category").addChoices(...CATEGORY_CHOICES)),

  new SlashCommandBuilder().setName("profile").setDescription("View a profile")
    .addUserOption(o=>o.setName("member").setDescription("Target (empty = yourself)")),

  new SlashCommandBuilder().setName("leaderboard").setDescription("Top 10 generators"),

  new SlashCommandBuilder().setName("add").setDescription("[Staff] Add accounts (bulk supported)")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addAttachmentOption(o=>o.setName("file").setDescription(".txt or .zip file").setRequired(true))
    .addBooleanOption(o=>o.setName("bulk").setDescription("Bulk import mode")),

  new SlashCommandBuilder().setName("remove").setDescription("[Mod] Remove accounts from stock")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("send").setDescription("[Staff] Send accounts via DM")
    .addUserOption(o=>o.setName("member").setDescription("Target").setRequired(true))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1))
    .addStringOption(o=>o.setName("tier").setDescription("Search in tier").addChoices(...TIER_CHOICES)),

new SlashCommandBuilder().setName("help").setDescription("List all commands"),
  new SlashCommandBuilder().setName("verify").setDescription("Start the verification process"),

  // NEW FEATURES COMMANDS
  new SlashCommandBuilder().setName("feedback").setDescription("Leave feedback about your generation")
    .addIntegerOption(o=>o.setName("rating").setDescription("Rating (1-5)").setRequired(true).setMinValue(1).setMaxValue(5))
    .addStringOption(o=>o.setName("comment").setDescription("Optional comment")),

  new SlashCommandBuilder().setName("announce").setDescription("[Admin] Broadcast message to all users")
    .addStringOption(o=>o.setName("message").setDescription("Message to send").setRequired(true))
    .addBooleanOption(o=>o.setName("dm").setDescription("Send via DM (default: true)").setRequired(false)),

  new SlashCommandBuilder().setName("backup").setDescription("[Admin] Force backup of all data"),

  new SlashCommandBuilder().setName("search").setDescription("[Staff] Search accounts in stock")
    .addStringOption(o=>o.setName("query").setDescription("Search term").setRequired(true))
    .addStringOption(o=>o.setName("tier").setDescription("Filter by tier").addChoices(...TIER_CHOICES)),

  new SlashCommandBuilder().setName("bulkadd").setDescription("[Staff] Bulk import accounts")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addStringOption(o=>o.setName("accounts").setDescription("Accounts (one per line)").setRequired(true)),

  new SlashCommandBuilder().setName("cooldown").setDescription("Check your remaining cooldowns"),

  new SlashCommandBuilder().setName("language").setDescription("Set your language preference")
    .addStringOption(o=>o.setName("lang").setDescription("Language").setRequired(true).addChoices(
      { name: "🇬🇧 English", value: "en" },
      { name: "🇫🇷 Français", value: "fr" },
    )),

  new SlashCommandBuilder().setName("categories").setDescription("View services by category")
    .addStringOption(o=>o.setName("category").setDescription("Category").addChoices(...CATEGORY_CHOICES)),

  new SlashCommandBuilder().setName("ratecheck").setDescription("[Staff] Check rate limits for a user")
    .addUserOption(o=>o.setName("member").setDescription("Target").setRequired(true)),

  new SlashCommandBuilder().setName("restock").setDescription("[Staff] Notify about restock")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Amount added").setRequired(true)),

].map(c=>c.toJSON());

async function registerCommands() {
  const rest = new REST().setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body:commands });
    console.log("✅ Slash commands registered");
  } catch(e) { console.error("Command registration failed:", e.message); }
}

// ── MIGRATE ACCOUNTS ──────────────────────────────────────────
// Move accounts/free/ → accounts/server1/free/ etc. if needed
async function migrateAccounts() {
  try {
    // Check if old structure exists (accounts/free/)
    const oldFree = await readLines(`${ACCOUNTS_DIR}/free/.gitkeep`).catch(()=>null);
    const files   = await listDir(ACCOUNTS_DIR).catch(()=>[]);
    const tiers   = ["free","premium","booster","extreme","paid"];
    const hasTierAtRoot = files.some(f => tiers.includes(f.name));
    if (!hasTierAtRoot) { console.log("✅ Accounts already migrated"); return; }

    console.log("🔄 Migrating accounts to per-server folders...");
    // For each guild, copy existing accounts to their folder
    for (const [guildId, cfg] of Object.entries(GUILDS)) {
      const dest = `${ACCOUNTS_DIR}/${cfg.folder}`;
      for (const tier of tiers) {
        try {
          const tierFiles = await listDir(`${ACCOUNTS_DIR}/${tier}`);
          for (const f of tierFiles) {
            if (!f.name.endsWith(".txt")) continue;
            const lines = await readLines(f.path);
            if (!lines.length) continue;
            const destPath = `${dest}/${tier}/${f.name}`;
            // Only write if destination doesn't exist yet
            const existing = await readLines(destPath);
            if (!existing.length) {
              await writeLines(destPath, lines);
              console.log(`  ✅ Copied ${f.path} → ${destPath}`);
            }
          }
        } catch(_) {}
      }
    }
    console.log("✅ Migration complete");
  } catch(e) {
    console.warn("Migration warning:", e.message);
  }
}

// ── HOURLY STOCK REPORT ───────────────────────────────────────
const STOCK_REPORT_CHANNEL = "1479080682616520716"; // Server 2 stock channel
const STOCK_REPORT_GUILD   = "1479080681572274320";

async function sendHourlyStockReport() {
  try {
    const guild = client.guilds.cache.get(STOCK_REPORT_GUILD);
    if (!guild) return;
    const channel = guild.channels.cache.get(STOCK_REPORT_CHANNEL);
    if (!channel) return;

    const tiers = ["free","premium","booster","extreme"];
    const acDir = getAccountsDir(STOCK_REPORT_GUILD);
    const embed = new EmbedBuilder()
      .setTitle("📦  Hourly Stock Report")
      .setColor(0x6366f1)
      .setTimestamp()
      .setFooter({text:"Updates every hour"});

    let totalAccounts = 0;
    for (const tier of tiers) {
      const meta  = TIER_META[tier] || TIER_META.free;
      const files = await listDir(`${acDir}/${tier}`).catch(()=>[]);
      const lines = [];
      for (const f of files) {
        if (!f.name.endsWith(".txt")) continue;
        const count = (await readLines(f.path)).length;
        totalAccounts += count;
        const bar = "█".repeat(Math.min(Math.floor(count/5),10)) + "░".repeat(Math.max(0,10-Math.min(Math.floor(count/5),10)));
        lines.push(`\`${bar}\` **${f.name.replace(".txt","")}** — ${count}`);
      }
      embed.addFields({
        name: `${meta.emoji} ${meta.label}`,
        value: lines.join("\n") || "*Empty*",
        inline: false,
      });
    }
    embed.setDescription(`**${totalAccounts}** accounts available across all tiers`);
    await channel.send({embeds:[embed]});
  } catch(e) { console.error("Hourly stock report error:", e.message); }
}

// ── READY ─────────────────────────────────────────────────────
let botReady = false;
client.once(Events.ClientReady, async () => {
  botReady = true;
  console.log(`🤖 Bot online: ${client.user.tag}`);
  client.user.setActivity("/help • Gen Bot", {type: 3}); // type 3 = Watching
  await loadGuildConfig();
  // Sync guilds with bot's current guild list
  try { await syncGuilds(client.guilds.cache); } catch(e) { console.warn("Guild sync failed:", e.message); }

  // Auto-setup ticket categories if missing
  try {
    for (const [guildId, guild] of client.guilds.cache) {
      const cfg = GUILDS[String(guildId)];
      if (!cfg) continue;
      if (!cfg.ticketCategory) {
        // Look for a "TICKETS" category or create one
        let cat = guild.channels.cache.find(c => c.type === 4 && /ticket/i.test(c.name));
        if (!cat) {
          cat = await guild.channels.create({ name: "Tickets", type: 4 }).catch(()=>null);
        }
        if (cat) {
          cfg.ticketCategory = cat.id;
          console.log(`✅ Auto-set ticketCategory for ${guild.name}: ${cat.id}`);
          const all = await readJson(CONFIG_FILE);
          all[guildId] = cfg;
          await writeJson(CONFIG_FILE, all);
        }
      }
    }
  } catch(e) { console.warn("Auto ticket category setup failed:", e.message); }

  await migrateAccounts();
  await registerCommands();
  await loadGiveaways();
  startBackupScheduler();

  // Send stock report every hour (NOT on startup to avoid restart spam)
  setInterval(sendHourlyStockReport, 60 * 60 * 1000);
  console.log("✅ Hourly stock report scheduled (every 60min, not on startup)");

  // Check all stock for low alerts on startup
  await checkAllStockAlerts();

  try {
    const res = await fetch(`${BACKEND}/internal/tickets_map`,{headers:{"X-Bot-Secret":BOT_SECRET}});
    if (res.ok) {
      const map = await res.json();
      for (const [tid,chId] of Object.entries(map)) channelToTicket.set(String(chId),String(tid));
      console.log(`✅ Restored ${Object.keys(map).length} ticket mappings`);
    }
  } catch(e) { console.warn("Could not restore ticket map:", e.message); }
});

// ── GUILD CREATE (auto-config new servers) ────────────────────
client.on(Events.GuildCreate, async (guild) => {
  const guildId = String(guild.id);
  if (GUILDS[guildId]) return; // Already configured

  console.log(`🆕 New guild joined: ${guild.name} (${guildId})`);
  // Create default config for this guild
  GUILDS[guildId] = {
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
    tierRoles: {
      free: [],
      premium: [],
      booster: [],
      extreme: []
    },
  };
  // Save to GitHub
  try {
    const all = await readJson(CONFIG_FILE);
    all[guildId] = GUILDS[guildId];
    await writeJson(CONFIG_FILE, all);
    console.log(`✅ Auto-configured guild ${guild.name}`);
  } catch(e) {
    console.error(`Failed to save guild config: ${e.message}`);
  }
});

// ── BIO LINK ROLE WATCHER ─────────────────────────────────────
client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
  try {
    const guild  = newPresence.guild;
    if (!guild) return;
    const cfg    = getCfg(guild.id);
    if (!cfg?.bioLinkRole || !cfg?.bioLink) return;

    const member = await guild.members.fetch(newPresence.userId).catch(()=>null);
    if (!member) return;

    // Check custom status (activity type 4) for the bio link
    const activities = newPresence.activities || [];
    const customStatus = activities.find(a => a.type === 4); // ActivityType.Custom = 4
    const statusText = customStatus?.state || customStatus?.name || "";
    const hasLink = statusText.includes(cfg.bioLink);
    console.log(`[bioLink] ${newPresence.userId} status="${statusText}" hasLink=${hasLink}`);

    const hasRole = member.roles.cache.has(cfg.bioLinkRole);

    if (hasLink && !hasRole) {
      await member.roles.add(cfg.bioLinkRole).catch(console.error);
      console.log(`✅ Bio link role added to ${member.user.username}`);
    } else if (!hasLink && hasRole) {
      await member.roles.remove(cfg.bioLinkRole).catch(console.error);
      console.log(`❌ Bio link role removed from ${member.user.username}`);
    }
  } catch(e) { console.error("PresenceUpdate error:", e.message); }
});

// Member join
client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = getCfg(member.guild.id);
  if (!cfg) return;
  // Log join
  const joinEmbed = new EmbedBuilder()
    .setTitle("📥  Member Joined")
    .setDescription(`${member} joined the server.`)
    .setColor(0x57F287)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      {name:"👤 User", value:`${member.user.tag}`, inline:true},
      {name:"🆔 ID",   value:member.id,             inline:true},
      {name:"📅 Account created", value:`<t:${Math.floor(member.user.createdTimestamp/1000)}:R>`, inline:false},
    )
    .setTimestamp();
  await sendLog(member.guild, joinEmbed);
  // Give not-verified role on join (server 2 only)
  if (member.guild.id === "1479080681572274320" && cfg.notVerifiedRole) {
    await member.roles.add(cfg.notVerifiedRole).catch(console.error);
    console.log(`📥 ${member.user.username} joined — gave not-verified role`);
  }
});

// Member leave
client.on(Events.GuildMemberRemove, async (member) => {
  const cfg = getCfg(member.guild.id);
  if (!cfg) return;
  const leaveEmbed = new EmbedBuilder()
    .setTitle("📤  Member Left")
    .setDescription(`${member.user.tag} left the server.`)
    .setColor(0xED4245)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      {name:"👤 User", value:`${member.user.tag}`, inline:true},
      {name:"🆔 ID",   value:member.id,             inline:true},
      {name:"📅 Joined", value:member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : "Unknown", inline:false},
    )
    .setTimestamp();
  await sendLog(member.guild, leaveEmbed);
});

// ── PREFIX COMMANDS (. prefix alternative) ───────────────────
const PREFIX = ".";
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  // Bridge ticket messages
  const tid = channelToTicket.get(String(message.channel.id));
  if (tid) {
    await notifyBackend(`/internal/ticket/${tid}/message`,{
      content:message.content, author:message.author.displayName||message.author.username,
    });
    return;
  }

  // Prefix commands (.gen, .stock, etc.)
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd  = args[0]?.toLowerCase();
  if (!cmd) return;

  // Map prefix command to slash command name
  const prefixCmds = ["gen","stock","profile","promote","leaderboard","help","web","xbox","addv","rvoutch","add","remove","send","rall","close","giveaway","verify","redeem"];
  if (!prefixCmds.includes(cmd)) return;

  // Notify user to use slash commands but keep it simple
  await message.reply({embeds:[new EmbedBuilder()
    .setTitle(`💡 Use \`/${cmd}\``)
    .setDescription(`Slash commands work the same way!
Type \`/${cmd}\` to use this command.`)
    .setColor(0x6366f1)
    .setFooter({text:"Gen Bot supports both / and . prefixes"})
  ]}).catch(()=>{});
});

// ── INTERACTIONS ──────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  // Define member and guild for slash commands
  const member = interaction.member || (interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(()=>null) : null);
  const guild  = interaction.guild;

  // ── REDEEM BUTTON ────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("redeem_btn_")) {
    const code   = interaction.customId.replace("redeem_btn_", "");
    const guild  = interaction.guild;
    const member = interaction.member;
    const cfg    = getCfg(guild.id);

    if (!isStaff(member)) {
      await interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle("⏳ Please wait for a staff member")
        .setDescription("Only staff can validate tickets.")
        .setColor(C.warn)], ephemeral:true });
      return;
    }

    await interaction.deferReply();
    const pending = await readJson(FILES.pending);
    if (!pending[code]) {
      return interaction.followUp({embeds:[err("Invalid Code","This code does not exist or has already been used.")]});
    }

    const { account, user:userId, webTicketId, tier:t, service } = pending[code];
    const target = await guild.members.fetch(userId).catch(()=>null);
    if (!target) return interaction.followUp({embeds:[err("Member Not Found","The user has left the server.")]});

    delete pending[code]; await writeJson(FILES.pending, pending);

    if (webTicketId) channelToTicket.set(String(interaction.channelId), String(webTicketId));
    if (webTicketId) await notifyBackend(`/internal/ticket/${webTicketId}/redeem`,{account});

    if (!webTicketId) {
      const dmPayload = await buildAccountDM(account, service, t);
      await target.send(dmPayload).catch(()=>{});
    }

    const newV = await addVouch(interaction.user.id);
    await checkAndPromote(guild, member, newV);

    // Disable the button
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`redeem_btn_${code}`)
        .setLabel("✅  Validated")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );
    await interaction.message.edit({components:[disabledRow]}).catch(()=>{});

    await interaction.followUp({embeds:[ok("Validated!",`Account sent to **${target.user.username}** via ${webTicketId?"web ticket":"DM"}.`)]});

    const l = log("📝 Redeem",`${interaction.user} validated for ${target.user}`)
      .addFields({name:"Account",value:`||${account}||`,inline:true},{name:"Vouches",value:`**${newV}**`,inline:true});
    if (webTicketId) l.addFields({name:"Source",value:"🌐 Web",inline:true});
    await sendLog(guild, l);

    if (!webTicketId) {
      await new Promise(r=>setTimeout(r,5000));
      await interaction.channel.delete().catch(console.error);
    }
    return;
  }

  // ── VERIFY BUTTON ────────────────────────────────
  if (interaction.isButton() && interaction.customId === "verify_start") {
    const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = await import("discord.js");
    const modal = new ModalBuilder()
      .setCustomId("verify_modal")
      .setTitle("🧮 Verification");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("verify_answer")
          .setLabel("What is 2 + 2 ?")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Enter your answer...")
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(5)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // ── VERIFY MODAL ──────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "verify_modal") {
    const answer = interaction.fields.getTextInputValue("verify_answer").trim();
    const guild  = interaction.guild;
    const member = interaction.member;
    const cfg    = getCfg(guild.id);

    if (answer !== "4") {
      await interaction.reply({
        embeds:[new EmbedBuilder()
          .setTitle("❌ Wrong Answer")
          .setDescription("That's not correct! Try again by clicking the button.")
          .setColor(C.error)
          .setFooter({text:"Gen Bot • Verification"})],
        ephemeral: true,
      });
      return;
    }

    // Correct — assign roles
    const rolesToAdd    = [cfg?.verifiedRole, cfg?.memberRole].filter(Boolean);
    const roleToRemove  = cfg?.notVerifiedRole;
    try {
      for (const rid of rolesToAdd) {
        if (!member.roles.cache.has(rid)) await member.roles.add(rid).catch(console.error);
      }
      if (roleToRemove && member.roles.cache.has(roleToRemove)) {
        await member.roles.remove(roleToRemove).catch(console.error);
      }
    } catch(e) { console.error("Verify role error:", e); }

    await interaction.reply({
      embeds:[new EmbedBuilder()
        .setTitle("✅ Verified!")
        .setDescription("You have been verified and now have access to the server. Welcome!")
        .setColor(C.success)
        .setFooter({text:"Gen Bot • Verification"})],
      ephemeral: true,
    });

    // Log
    await sendLog(guild, log("✅ Member Verified", `${interaction.user} passed verification.`).setColor(C.success));
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try { await handleCommand(interaction, commandName); }
  catch(e) {
    console.error(`/${commandName} error:`, e);
    const embed = err("Error", e.message);
    try {
      if (interaction.deferred||interaction.replied) await interaction.followUp({embeds:[embed],ephemeral:true});
      else await interaction.reply({embeds:[embed],ephemeral:true});
    } catch(_) {}
  }
});

// ── COMMAND HANDLER ───────────────────────────────────────────
async function handleCommand(interaction, name) {
  const { guild, member } = interaction;
  const cfg = getCfg(guild?.id);
  console.log(`[cmd/${name}] guildId=${guild?.id} cfgFound=${!!cfg} GUILDS=${Object.keys(GUILDS).join(",")}`);

  // ── /gen ──────────────────────────────────────────
  if (name === "gen") {
    await interaction.deferReply();
    if (!cfg) return interaction.followUp({embeds:[err("Error","Server not configured.")]});

    const t       = interaction.options.getString("tier");
    const service = capitalize(interaction.options.getString("service"));
    const meta    = TIER_META[t];

    // Support paidChannel as fallback for booster/extreme in servers without those tiers
    const chKey   = cfg[`${t}Channel`] ? `${t}Channel` : `${t === "booster" || t === "extreme" ? "paid" : t}Channel`;
    const chId    = cfg[chKey] || cfg[`${t}Channel`];
    if (chId && interaction.channelId !== chId)
      return interaction.followUp({embeds:[err("Wrong Channel",`Use <#${chId}> for the **${meta.label}** tier.`)]});

    // Server 2: free tier requires bio link role
    if (cfg.bioLinkRole && t === "free" && !isMod(member)) {
      if (!member.roles.cache.has(cfg.bioLinkRole)) {
        return interaction.followUp({embeds:[err("Role Required",
          `You need to have \`${cfg.bioLink}\` in your custom status to generate free accounts.`
        )]});
      }
    }

    if (!isMod(member)) {
      const cd = checkBotCooldown(interaction.user.id, t);
      if (!cd.ok) {
        const m=Math.floor(cd.wait/60), s=cd.wait%60;
        return interaction.followUp({embeds:[warn("Cooldown",`Wait **${m}m ${s}s** before generating again.`)]});
      }
    }

    const acDir = getAccountsDir(guild.id);
    const path  = `${acDir}/${t}/${service}.txt`;
    const stock = await readLines(path);
    if (!stock.length) return interaction.followUp({embeds:[err("Out of Stock",`No **${service}** accounts available in **${meta.label}**.`)]});

    const account = stock.shift(); await writeLines(path, stock);
    const code    = crypto.randomBytes(3).toString("hex").toUpperCase();
    const pending = await readJson(FILES.pending);
    pending[code] = { account, user:interaction.user.id, tier:t, service };
    await writeJson(FILES.pending, pending);

    const category = guild.channels.cache.get(cfg.ticketCategory);
    if (!category) return interaction.followUp({embeds:[err("Error","Ticket category not found.")]});

    const ticketCh = await guild.channels.create({
      name:   `${service.toLowerCase()}-${interaction.user.username.toLowerCase()}-${Math.floor(Math.random()*9000+1000)}`,
      parent: category,
      permissionOverwrites:[
        { id:guild.id,              deny: [PermissionsBitField.Flags.ViewChannel] },
        { id:interaction.user.id,   allow:[PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id:client.user.id,        allow:[PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id:cfg.staffRole,         allow:[PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ],
    });

    const te = new EmbedBuilder()
      .setTitle(`${meta.emoji}  New Generation Ticket`)
      .setColor(meta.color)
      .setDescription(`A new account has been requested by ${interaction.user}.`)
      .addFields(
        { name:"👤 Member",   value:interaction.user.toString(),          inline:true },
        { name:"📦 Service",  value:`**${service}**`,                     inline:true },
        { name:"🏷️ Tier",    value:`${meta.emoji} **${meta.label}**`,    inline:true },
        { name:"🔑 Code",     value:`\`\`\`${code}\`\`\``,                inline:false },
      )
      .setFooter({ text:`📦 Stock remaining: ${stock.length} • Gen Bot` })
      .setTimestamp();

    const redeemRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`redeem_btn_${code}`)
        .setLabel("✅  Validate Account")
        .setStyle(ButtonStyle.Success)
    );
    await ticketCh.send({ content:`<@&${cfg.staffRole}>`, embeds:[te], components:[redeemRow] });
    await interaction.followUp({ embeds:[
      ok("Ticket Created!",`Your ticket ${ticketCh} has been opened!\nA staff member will assist you shortly.`)
        .addFields({ name:"📦 Service", value:`**${service}** (${meta.label})`, inline:true })
    ]});

    const stats = await readJson(FILES.stats);
    const uid   = interaction.user.id;
    stats[uid]  = (stats[uid]||0)+1;
    const tk    = uid+"_tiers"; stats[tk]=stats[tk]||{};
    stats[tk][t]=(stats[tk][t]||0)+1;
    await writeJson(FILES.stats, stats);
    await sendLog(guild, log("📝 Generation",`${interaction.user} generated **${service}** (${meta.label})`).addFields({name:"Ticket",value:ticketCh.toString()}));
    return;
  }

  // ── /redeem ───────────────────────────────────────
  if (name === "redeem") {
    await interaction.deferReply();
    // Validation is now done via the button in the ticket channel
    return interaction.followUp({embeds:[new EmbedBuilder()
      .setTitle("ℹ️ Use the button")
      .setDescription("Ticket validation is now done via the **✅ Validate Account** button in the ticket channel.")
      .setColor(C.info)
      .setFooter({text:"Gen Bot"})]});
    if (!isStaff(member)) {
            return interaction.followUp({embeds:[
        new EmbedBuilder()
          .setTitle("⏳ Please wait for a staff member")
          .setDescription("Only staff can validate tickets.\nA staff member will assist you shortly!")
          .setColor(C.warn)
          .setFooter({text:"Gen Bot"})
      ]});
    }

    const code    = interaction.options.getString("code").toUpperCase();
    const pending = await readJson(FILES.pending);
    if (!pending[code]) return interaction.followUp({embeds:[err("Invalid Code","This code does not exist or has already been used.")]});

    const { account, user:userId, webTicketId, tier:t, service } = pending[code];
    const target = await guild.members.fetch(userId).catch(()=>null);
    if (!target) return interaction.followUp({embeds:[err("Member Not Found","The user has left the server.")]});

    delete pending[code]; await writeJson(FILES.pending, pending);

    if (webTicketId) channelToTicket.set(String(interaction.channelId), String(webTicketId));
    if (webTicketId) await notifyBackend(`/internal/ticket/${webTicketId}/redeem`,{account});

    if (!webTicketId) {
      const meta   = TIER_META[t]||TIER_META.free;
      const dmEmbed = new EmbedBuilder()
        .setTitle("📦  Your Account is Ready!")
        .setDescription("Do not share this with anyone!")
        .setColor(meta.color)
        .addFields({ name:"🔐 Credentials", value:`\`\`\`${account}\`\`\`` })
        .setTimestamp();
      await target.send({embeds:[dmEmbed]}).catch(()=>{});
    }

    const newV = await addVouch(interaction.user.id);
    await checkAndPromote(guild, member, newV);

    await interaction.followUp({embeds:[ok("Validated!",`Account sent to **${target.user.username}** via ${webTicketId?"web ticket":"DM"}.`)]});

    const l = log("📝 Redeem",`${interaction.user} validated ticket for ${target.user}`)
      .addFields({name:"Account",value:`||${account}||`,inline:true},{name:"Vouches",value:`**${newV}**`,inline:true});
    if (webTicketId) l.addFields({name:"Source",value:"🌐 Web",inline:true});
    await sendLog(guild, l);

    if (!webTicketId) {
      await new Promise(r=>setTimeout(r,5000));
      await interaction.channel.delete().catch(console.error);
    } else {
      await interaction.channel.send({embeds:[
        new EmbedBuilder().setTitle("✅ Account Validated").setDescription(`Sent via web ticket.`).setColor(C.success)
      ]});
    }
    return;
  }

  // ── /close ────────────────────────────────────────
  if (name === "close") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});
    const chId = String(interaction.channelId);
    const tid  = channelToTicket.get(chId);
    if (tid) { channelToTicket.delete(chId); await notifyBackend(`/internal/ticket/${tid}/close`); }
    await interaction.followUp({embeds:[log("🔒 Ticket Closed",`Closed by ${interaction.user}`).setColor(C.error)]});
    await new Promise(r=>setTimeout(r,5000));
    await interaction.channel.delete().catch(console.error);
    return;
  }

  // ── /giveaway ─────────────────────────────────────
  if (name === "giveaway") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});

    const service = capitalize(interaction.options.getString("service"));
    const t       = interaction.options.getString("tier");
    const duree   = interaction.options.getInteger("duree");
    const meta    = TIER_META[t];

    // Check stock
    const acDir2 = getAccountsDir(guild.id);
    const path  = `${acDir2}/${t}/${service}.txt`;
    const stock = await readLines(path);
    if (!stock.length) return interaction.followUp({embeds:[err("Out of Stock",`No **${service}** accounts available in **${meta.label}**.`)]});

    // Reserve account
    const account = stock.shift(); await writeLines(path, stock);

    const endsAt  = new Date(Date.now() + duree*60*1000);
    const endTs   = Math.floor(endsAt.getTime()/1000);

    const gwEmbed = new EmbedBuilder()
      .setTitle("🎁  GIVEAWAY !")
      .setColor(meta.color)
      .addFields(
        { name:"📦 Service",   value:`**${service}**`,                      inline:true },
        { name:"🏷️ Tier",     value:`${meta.emoji} **${meta.label}**`,     inline:true },
        { name:"⏰ Fin",       value:`<t:${endTs}:R>`,                      inline:true },
        { name:"🎫 How to Enter",value:"React with 🎉 to participate!",    inline:false },
      )
      .setFooter({ text:`Hosted by ${interaction.user.displayName}` })
      .setTimestamp();

    const gwMsg = await interaction.channel.send({ embeds:[gwEmbed] });
    await gwMsg.react("🎉");
    await interaction.followUp({ content:"✅ Giveaway Started!", ephemeral:true });

    // Store giveaway
    const gwData = {
      channelId: String(interaction.channelId),
      guildId:   String(guild.id),
      service, tier:t, account,
      endsAt:    endsAt.toISOString(),
      ended:     false,
    };
    activeGiveaways.set(gwMsg.id, gwData);
    await saveGiveaways();

    setTimeout(()=>endGiveaway(gwMsg.id), duree*60*1000);

    await sendLog(guild, log("🎁 Giveaway Started",`${interaction.user} started a giveaway **${service}** (${meta.label}) — duration: ${duree}min`));
    return;
  }

  // ── /addv ─────────────────────────────────────────
  if (name === "addv") {
    await interaction.deferReply();
    if (!hasAddv(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});
    const target = interaction.options.getMember("member");
    const amount = interaction.options.getInteger("amount");
    const newV   = await addVouch(target.id, amount);
    await checkAndPromote(guild, target, newV);
    await interaction.followUp({embeds:[ok("Vouches Added!",`+**${amount}** vouches for ${target}. Total: **${newV}**.`)]});
    await sendLog(guild, log("📝 Vouches",`${interaction.user} +${amount} → ${target.user}`).addFields({name:"Total",value:`**${newV}**`,inline:true}));
    return;
  }

  // ── /rvoutch ──────────────────────────────────────
  if (name === "rvoutch") {
    await interaction.deferReply();
    if (!hasAddv(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});
    const target = interaction.options.getMember("member");
    const amount = interaction.options.getInteger("amount");
    const d = await readJson(FILES.vouches);
    const uid = target.id;
    const current = d[String(uid)] || 0;
    d[String(uid)] = Math.max(0, current - amount);
    await writeJson(FILES.vouches, d);
    const newV = d[String(uid)];
    await interaction.followUp({embeds:[ok("Vouches Removed!",`-**${amount}** vouches from ${target}. Total: **${newV}**.`)]});
    await sendLog(guild, log("📝 Vouches Removed",`${interaction.user} -${amount} → ${target.user}`).addFields({name:"Total",value:`**${newV}**`,inline:true}));
    return;
  }

  // ── /rall ────────────────────────────────────────
  if (name === "rall") {
    await interaction.deferReply();
    if (!hasAddv(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});
    const t = interaction.options.getString("tier");
    const acDirRall = getAccountsDir(guild.id);
    // Delete ALL services in this tier
    const files = await listDir(`${acDirRall}/${t}`);
    if (!files.length) return interaction.followUp({embeds:[err("Empty",`No stock found in tier **${t}**.`)]});
    let totalRemoved = 0;
    const servicesRemoved = [];
    for (const f of files) {
      if (!f.name.endsWith(".txt")) continue;
      const lines = await readLines(f.path);
      totalRemoved += lines.length;
      servicesRemoved.push(f.name.replace(".txt",""));
      await writeLines(f.path, []);
    }
    await interaction.followUp({embeds:[ok("Tier Cleared!",
      `**${t}** tier has been completely cleared.
**${totalRemoved}** accounts removed across **${servicesRemoved.length}** services:
${servicesRemoved.map(s=>`\`${s}\``).join(", ")}`)
    ]});
    await sendLog(guild, log("🗑️ Tier Cleared",`${interaction.user} cleared entire **${t}** tier (${totalRemoved} accounts, ${servicesRemoved.length} services)`).setColor(C.error));
    return;
  }

  // ── /web ──────────────────────────────────────────
  if (name === "web") {
    const SITE = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : (process.env.SITE_URL || "https://web-production-06585.up.railway.app");
    // Send as a plain message with clickable link (embeds can suppress previews)
    await interaction.reply({
      content: `🌐 **Gen Bot — Website**
${SITE}`,
    });
    return;
  }

  // ── /xbox ────────────────────────────────────────
  if (name === "xbox") {
    await interaction.deferReply();
    const gamertag = interaction.options.getString("gamertag");
    const apiKey = process.env.XBL_API_KEY;
    if (!apiKey) return interaction.followUp({embeds:[err("Not configured","XBL_API_KEY is not set.")]});
    try {
      const res = await fetch(`https://xbl.io/api/v2/search?q=${encodeURIComponent(gamertag)}`, {
        headers: { "X-Authorization": apiKey, "Accept": "application/json" }
      });
      if (!res.ok) return interaction.followUp({embeds:[err("Not found",`Could not find gamertag: **${gamertag}**`)]});
      const data = await res.json();
      const profile = data.people?.[0];
      if (!profile) return interaction.followUp({embeds:[err("Not found",`No results for **${gamertag}**`)]});
      const embed = new EmbedBuilder()
        .setTitle(`🎮 ${profile.gamertag || gamertag}`)
        .setColor(0x107C10) // Xbox green
        .setThumbnail(profile.displayPicRaw || null)
        .addFields(
          { name:"🎮 Gamertag",    value: profile.gamertag || "N/A",                          inline: true },
          { name:"🏆 Gamerscore",  value: String(profile.gamerScore || 0),                    inline: true },
          { name:"👥 Followers",   value: String(profile.detail?.followerCount || 0),          inline: true },
          { name:"📍 Location",    value: profile.detail?.location || "Unknown",               inline: true },
          { name:"💬 Bio",         value: profile.detail?.bio || "No bio",                     inline: false },
        )
        .setURL(`https://xbl.io/app/profile/${profile.xuid}`)
        .setFooter({ text: "Data from xbl.io" })
        .setTimestamp();
      await interaction.followUp({ embeds: [embed] });
    } catch(e) {
      await interaction.followUp({embeds:[err("Error", `Failed to fetch profile: ${e.message}`)]});
    }
    return;
  }

  // ── /promote ──────────────────────────────────────
  if (name === "promote") {
    await interaction.deferReply();
    const target  = interaction.options.getMember("member")||member;
    const vouches = await getVouches(target.id);
    const cfg2    = getCfg(guild.id);
    const embed   = new EmbedBuilder().setTitle("🏅  Vouch Progress")
      .setDescription(`Stats for ${target}`).setColor(C.info).setThumbnail(target.user.displayAvatarURL())
      .addFields({name:"⭐ Total",value:`**${vouches}**`,inline:true});
    const next = cfg2?.vouchTiers.find(vt=>vouches<vt.threshold);
    if (next) {
      const filled=Math.round(Math.min(vouches/next.threshold,1)*10);
      embed.addFields(
        {name:"🎯 Next",value:`**${next.threshold}** → ${next.roles.map(r=>`<@&${r}>`).join(" ")}`,inline:true},
        {name:"📊 Progress",value:`\`${"█".repeat(filled)}${"░".repeat(10-filled)}\` ${vouches}/${next.threshold}`,inline:false},
      );
    } else embed.addFields({name:"🏆",value:"Maximum rank reached!",inline:false});
    if (cfg2) {
      embed.addFields({name:"📋 Milestones",value:cfg2.vouchTiers.map(vt=>`${vouches>=vt.threshold?"✅":"🔒"} **${vt.threshold}** → ${vt.roles.map(r=>`<@&${r}>`).join(" ")}`).join("\n"),inline:false});
    }
    embed.setFooter({text:"Vouches earned by validating tickets"}).setTimestamp();
    await interaction.followUp({embeds:[embed]});
    return;
  }

  // ── /stock ────────────────────────────────────────
  if (name === "stock") {
    await interaction.deferReply();
    const tf = interaction.options.getString("tier");
    // Server 2 only has free/premium/paid
    const serverTiers = TIERS; // Both servers: free/premium/booster/extreme
    const tiers = tf ? [tf] : serverTiers;
    const embed = new EmbedBuilder().setTitle(`📦  Stock${tf?` — ${TIER_META[tf].label}`:""}`).setColor(tf?TIER_META[tf].color:C.info).setTimestamp();
    let total=0;
    for (const t of tiers) {
      const acDirStock=getAccountsDir(guild.id); const files=await listDir(`${acDirStock}/${t}`); const lines=[];
      for (const f of files) { if (!f.name.endsWith(".txt")) continue; const count=(await readLines(f.path)).length; total+=count; const bar="█".repeat(Math.min(Math.floor(count/10),10))+"░".repeat(Math.max(0,10-Math.min(Math.floor(count/10),10))); lines.push(`\`${bar}\` **${f.name.replace(".txt","")}** — ${count}`); }
      embed.addFields({name:`${TIER_META[t].emoji} ${TIER_META[t].label}`,value:lines.join("\n")||"*Empty*",inline:false});
    }
    embed.setFooter({text:`Total: ${total} accounts`});
    await interaction.followUp({embeds:[embed]});
    return;
  }

  // ── /profile ──────────────────────────────────────
  if (name === "profile") {
    await interaction.deferReply();
    const target=interaction.options.getMember("member")||member;
    const uid=target.id; const stats=await readJson(FILES.stats);
    const total=typeof stats[uid]==="number"?stats[uid]:0;
    const td=stats[uid+"_tiers"]||{};
    const vouches=await getVouches(uid); const now=Date.now();
    const bar=(uses,max)=>"🟩".repeat(Math.round((uses/max)*5))+"⬛".repeat(5-Math.round((uses/max)*5))+`  \`${uses}/${max}\``;
    const getUses=(t)=>(botCooldowns.get(`${uid}:${t}`)||[]).filter(ts=>now-ts<3600000).length;
    const embed=new EmbedBuilder().setTitle("👤  Profile").setDescription(`Stats for ${target}`).setColor(C.info).setThumbnail(target.user.displayAvatarURL())
      .addFields(
        {name:"🎯 Total Gens",value:`**${total}**`,inline:true},
        {name:"⭐ Vouches",   value:`**${vouches}**`,inline:true},
        {name:"\u200b",       value:"\u200b",inline:true},
        ...TIERS.map(t=>({name:`${TIER_META[t].emoji} ${TIER_META[t].label}`,value:`**${td[t]||0}**`,inline:true})),
        {name:"\u200b",value:"\u200b",inline:false},
        ...TIERS.map(t=>({name:`Quota ${TIER_META[t].label}`,value:bar(getUses(t),COOLDOWN_LIMITS[t].max),inline:true})),
      )
      .setFooter({text:"Quota resets every hour • Vouches never reset"}).setTimestamp();
    await interaction.followUp({embeds:[embed]});
    return;
  }

  // ── /leaderboard ──────────────────────────────────
  if (name === "leaderboard") {
    await interaction.deferReply();
    const stats=await readJson(FILES.stats);
    const top=Object.entries(stats).filter(([k,v])=>/^\d+$/.test(k)&&typeof v==="number").sort(([,a],[,b])=>b-a).slice(0,10);
    const medals=["🥇","🥈","🥉"];
    const embed=new EmbedBuilder().setTitle("🏆  Leaderboard").setColor(0xFFD166).setTimestamp();
    if (!top.length) embed.setDescription("*No generations yet.*");
    else {
      const lines=await Promise.all(top.map(async([uid,count],i)=>{
        const m=await guild.members.fetch(uid).catch(()=>null);
        return `${medals[i]||`\`#${i+1}\``}  **${m?.displayName||`User #${uid}`}** — ${count} gen${count>1?"s":""}`;
      }));
      embed.setDescription(lines.join("\n"));
    }
    embed.setFooter({text:`Requested by ${interaction.user.displayName}`});
    await interaction.followUp({embeds:[embed]});
    return;
  }

  // ── /add ──────────────────────────────────────────
  if (name === "add") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});
    const t=interaction.options.getString("tier"), service=capitalize(interaction.options.getString("service")), file=interaction.options.getAttachment("file");
    // Validate tier is valid for this server
    const validTiers = getServerTiers(guild.id);
    if (!validTiers.includes(t)) return interaction.followUp({embeds:[err("Invalid Tier",`This server only supports: **${validTiers.join(", ")}**`)]});
    // Support .txt and .zip
    const fileExt = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (![".txt",".zip"].includes(fileExt)) return interaction.followUp({embeds:[err("Invalid File","Only .txt or .zip files are accepted.")]});
    let lines = [];
    if (fileExt === ".txt") {
      const res = await fetch(file.url);
      const text = await res.text();
      lines = text.split("\n").map(l=>l.trim()).filter(Boolean);
    } else {
      // ZIP: each .txt inside = one account entry stored as FILE:base64
      const { default: unzipper } = await import("unzipper");
      const res = await fetch(file.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const dir = await unzipper.Open.buffer(buf);
      for (const entry of dir.files) {
        if (entry.path.endsWith(".txt") && entry.type === "File") {
          const content = await entry.buffer();
          const fileText = content.toString("utf8").trim();
          if (fileText) {
            // FILE: prefix = full file delivered as .txt attachment on gen
            lines.push("FILE:" + Buffer.from(fileText).toString("base64"));
          }
        }
      }
      if (!lines.length) return interaction.followUp({embeds:[err("Empty ZIP","No .txt files found inside the zip.")]});
    }
    const acDirAdd=getAccountsDir(guild.id); const path=`${acDirAdd}/${t}/${service}.txt`; const stock=await readLines(path); stock.push(...lines); await writeLines(path,stock);
    await interaction.followUp({embeds:[ok("Stock Updated!",`**${lines.length}** accounts added → \`${t}/${service}\`. Total: **${stock.length}**.`)]});
    await sendLog(guild, log("📝 Stock Added",`${interaction.user} +${lines.length} → \`${t}/${service}\``));
    return;
  }

  // ── /remove ───────────────────────────────────────
  if (name === "remove") {
    await interaction.deferReply();
    if (!isMod(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});
    const t=interaction.options.getString("tier"), service=capitalize(interaction.options.getString("service")), amount=interaction.options.getInteger("amount");
    const validTiers2 = getServerTiers(guild.id);
    if (!validTiers2.includes(t)) return interaction.followUp({embeds:[err("Invalid Tier",`This server only supports: **${validTiers2.join(", ")}**`)]});
    const acDirRm=getAccountsDir(guild.id); const path=`${acDirRm}/${t}/${service}.txt`; const stock=await readLines(path);
    if (stock.length<amount) return interaction.followUp({embeds:[warn("Insufficient Stock",`Only **${stock.length}** accounts available.`)]});
    stock.splice(0,amount); await writeLines(path,stock);
    await interaction.followUp({embeds:[ok("Removed!",`**${amount}** accounts removed. Remaining: **${stock.length}**.`)]});
    await sendLog(guild, log("📝 Stock Removed",`${interaction.user} -${amount} → \`${t}/${service}\``));
    return;
  }

  // ── /send ─────────────────────────────────────────
  if (name === "send") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});
    const target=interaction.options.getMember("member"), service=capitalize(interaction.options.getString("service")), amount=interaction.options.getInteger("amount");
    if (!isMod(member)) {
      const cdD=await readJson(FILES.sendCd); const now=Date.now(); const key=interaction.user.id;
      const uses=(cdD[key]||[]).filter(ts=>now-ts<3600000);
      if (uses.length>=5) return interaction.followUp({embeds:[warn("Limit Reached","Max 5 sends per hour.")]});
      uses.push(now); cdD[key]=uses; await writeJson(FILES.sendCd,cdD);
    }
    let sent=false;
    for (const t of TIERS) {
      const acDirSend=getAccountsDir(guild.id); const path=`${acDirSend}/${t}/${service}.txt`; const stock=await readLines(path);
      if (stock.length>=amount) {
        const accs=stock.splice(0,amount); await writeLines(path,stock);
        if (accs.length >= 2) {
          // Multiple accounts → bundle as .zip
          const AdmZip = (await import("adm-zip")).default;
          const zip = new AdmZip();
          accs.forEach((acc, i) => {
            const content = acc.startsWith("FILE:") 
              ? Buffer.from(acc.slice(5), "base64") 
              : Buffer.from(acc, "utf8");
            zip.addFile(`${service}_${i+1}.txt`, content);
          });
          const { AttachmentBuilder } = await import("discord.js");
          const zipBuf = zip.toBuffer();
          const zipFile = new AttachmentBuilder(zipBuf, {name:`${service}_x${accs.length}.zip`});
          const zipEmbed = new EmbedBuilder()
            .setTitle("📦  Your Accounts are Ready!")
            .setColor(TIER_META[t].color)
            .addFields(
              {name:"📦 Service", value:`**${service}**`, inline:true},
              {name:"🔢 Count",   value:`**${accs.length}** accounts`, inline:true},
            )
            .setDescription("Your accounts are bundled in the zip file below.")
            .setFooter({text:"Gen Bot • Do not share!"})
            .setTimestamp();
          await target.send({embeds:[zipEmbed], files:[zipFile]}).catch(()=>{});
        } else {
          const sendPayload = await buildAccountDM(accs[0], service, t);
          await target.send(sendPayload).catch(()=>{});
        }
        sent=true; await interaction.followUp({embeds:[ok("Sent!",`**${amount}** **${service}** accounts sent to ${target}.`)]}); break;
      }
    }
    if (!sent) await interaction.followUp({embeds:[err("No Stock",`Not enough **${service}** accounts.`)]});
    else await sendLog(guild, log("📝 Direct Send",`${interaction.user} → ${target.user} x${amount} \`${service}\``));
    return;
  }

  // ── /verify ──────────────────────────────────────
  if (name === "verify") {
    if (!cfg) return interaction.reply({embeds:[err("Error","Server not configured.")],ephemeral:true});
    // Check if user has verify role
    const verifyRole = cfg.verifyRole;
    if (verifyRole && !member.roles.cache.has(verifyRole)) {
      return interaction.reply({embeds:[err("Access Denied","You do not have permission to use this command.")],ephemeral:true});
    }
    // Check if this is server 2
    if (guild.id !== "1479080681572274320") {
      return interaction.reply({embeds:[err("Error","This command is only available on Server 2.")],ephemeral:true});
    }

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = await import("discord.js");

    const embed = new EmbedBuilder()
      .setTitle("🛡️  Verification Required")
      .setDescription("**Welcome to the server!**\n\nTo gain access, you need to pass a quick verification.\n\nClick the button below and answer the question to get verified.")
      .setColor(0x6366f1)
      .setFooter({text:"Gen Bot • Verification System"})
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("verify_start")
        .setLabel("✅  Click to Verify")
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({embeds:[embed], components:[row]});
    return;
  }

  // ── /help ─────────────────────────────────────────
  if (name === "help") {
    const lang = getUserLang(interaction.user);
    const embed=new EmbedBuilder().setTitle("📜  Commands — Gen Bot").setColor(C.info)
      .addFields(
        {name: t("genSelectTier", lang),  value:"`/gen` `/profile` `/promote` `/leaderboard` `/stock` `/categories` `/cooldown` `/feedback` `/language`",inline:false},
        {name:"🛡️  Staff",   value:"`/redeem` `/close` `/giveaway` `/add` `/send` `/remove` `/addv` `/rvoutch` `/rall` `/bulkadd` `/search` `/ratecheck` `/restock` `/announce` `/backup`",inline:false},
        {name:"ℹ️  Info",     value:"`/web` `/xbox` `/verify`",inline:false},
        {name:"🏷️  Tiers",   value:TIERS.map(t=>`${TIER_META[t].emoji} \`${t}\``).join(" · "),inline:false},
        {name:"🆕  NEW",      value:"`/feedback` `/announce` `/backup` `/bulkadd` `/search` `/categories` `/cooldown` `/language` `/ratecheck` `/restock`",inline:false},
      )
      .setFooter({text:"Gen Bot • Use /language to change language"})
      .setTimestamp();
    await interaction.reply({embeds:[embed]});
    return;
  }

  // ── NEW FEATURE COMMANDS ─────────────────────────────

  // ── /feedback ──────────────────────────────
  if (name === "feedback") {
    await interaction.deferReply({ ephemeral: true });
    const rating = interaction.options.getInteger("rating");
    const comment = interaction.options.getString("comment") || "";
    const lang = getUserLang(interaction.user);

    // Get last generation for this user
    const genlog = await readJson(FILES.genlog);
    const history = genlog[interaction.user.id] || [];
    const lastGen = history[0];
    const service = lastGen?.service || "";
    const tier = lastGen?.tier || "";

    await saveFeedback(interaction.user.id, rating, comment, service, tier);

    const stars = "⭐".repeat(rating) + "☆".repeat(5 - rating);
    await interaction.followUp({
      embeds: [ok(t("feedbackThanks", lang), `${stars}\n\n${comment ? `**Comment:** ${comment}` : ""}`)],
      ephemeral: true,
    });

    await sendLog(guild, fancy("💬 Feedback Received", `${interaction.user} rated ${stars} (${rating}/5)${comment ? `\nComment: ${comment}` : ""}`, C.purple));
    return;
  }

  // ── /announce ───────────────────────────────
  if (name === "announce") {
    await interaction.deferReply();
    if (!isMod(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});

    const message = interaction.options.getString("message");
    const sendDM = interaction.options.getBoolean("dm") ?? true;
    const lang = getUserLang(interaction.user);

    try {
      const sentCount = await announceToAll(guild.id, message, sendDM);
      await interaction.followUp({embeds:[ok(t("announceSent", lang, {count: sentCount}), `Message broadcasted to **${sentCount}** users!`)]});
      await sendLog(guild, fancy("📢 Announcement", `${interaction.user} sent announcement to ${sentCount} users`, C.info));
    } catch (e) {
      await interaction.followUp({embeds:[err("Error", e.message)]});
    }
    return;
  }

  // ── /backup ─────────────────────────────────
  if (name === "backup") {
    await interaction.deferReply();
    if (!isMod(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});

    await interaction.followUp({embeds:[warn("Backup Started","Please wait...")]});
    await performBackup();
    await interaction.editReply({embeds:[ok("Backup Complete!","All data has been backed up to GitHub.")]});
    return;
  }

  // ── /search ──────────────────────────────────
  if (name === "search") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});

    const query = interaction.options.getString("query").toLowerCase();
    const tierFilter = interaction.options.getString("tier");
    const lang = getUserLang(interaction.user);

    const results = await searchAccounts(guild.id, query, tierFilter);

    if (!results.length) {
      return interaction.followUp({embeds:[warn(t("noResults", lang), `No accounts found matching "${query}"`)]});
    }

    const embed = new EmbedBuilder()
      .setTitle(`🔍 ${t("searchResults", lang)}: "${query}"`)
      .setColor(C.info)
      .setTimestamp();

    for (const r of results.slice(0, 5)) { // Limit to 5 results
      const meta = TIER_META[r.tier] || TIER_META.free;
      const preview = r.lines.map(l => `• ${l.slice(0, 30)}...`).join("\n");
      embed.addFields({
        name: `${meta.emoji} ${r.service} (${r.tier}) — ${r.count} accounts`,
        value: preview || "*No preview*",
        inline: false,
      });
    }

    await interaction.followUp({embeds:[embed]});
    return;
  }

  // ── /bulkadd ────────────────────────────────
  if (name === "bulkadd") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});

    const t = interaction.options.getString("tier");
    const service = capitalize(interaction.options.getString("service"));
    const accountsStr = interaction.options.getString("accounts");
    const lang = getUserLang(interaction.user);

    const lines = accountsStr.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return interaction.followUp({embeds:[err(t("error", lang),"No valid accounts provided.")]});

    const acDir = getAccountsDir(guild.id);
    const path = `${acDir}/${t}/${service}.txt`;
    const stock = await readLines(path);
    stock.push(...lines);
    await writeLines(path, stock);

    await interaction.followUp({embeds:[ok("Bulk Import Complete!", `**${lines.length}** accounts added to \`${t}/${service}\`.\nTotal: **${stock.length}** accounts.`)]});

    // Check if this is a restock (if stock was low)
    if (stock.length - lines.length <= STOCK_ALERT_THRESHOLD) {
      await notifyRestock(guild, t, service, lines.length);
    }

    await sendLog(guild, log("📝 Bulk Added", `${interaction.user} +${lines.length} → \`${t}/${service}\` (bulk import)`));
    return;
  }

  // ── /cooldown ───────────────────────────────
  if (name === "cooldown") {
    await interaction.deferReply({ ephemeral: true });
    const displays = getCooldownDisplay(interaction.user.id);
    const lang = getUserLang(interaction.user);

    if (!displays.length) {
      return interaction.followUp({embeds:[ok(t("noCooldown", lang), "You have no active cooldowns!")]});
    }

    const embed = new EmbedBuilder()
      .setTitle("⏱️  Cooldown Status")
      .setColor(C.warn)
      .setTimestamp();

    for (const d of displays) {
      const meta = TIER_META[d.tier] || TIER_META.free;
      embed.addFields({
        name: `${meta.emoji} ${meta.label}`,
        value: `Time left: **${formatCooldown(d.wait)}**\nRemaining: **${d.remaining}**/${COOLDOWN_LIMITS[d.tier]?.max || "?"}`,
        inline: true,
      });
    }

    await interaction.followUp({embeds:[embed], ephemeral: true});
    return;
  }

  // ── /language ───────────────────────────────
  if (name === "language") {
    await interaction.deferReply({ ephemeral: true });
    const lang = interaction.options.getString("lang");
    const userLang = lang === "fr" ? "fr" : "en";

    // Save preference (in a simple way - could be enhanced to use a DB)
    const langPrefs = await readJson("lang_prefs.json").catch(() => ({}));
    langPrefs[interaction.user.id] = userLang;
    await writeJson("lang_prefs.json", langPrefs);

    await interaction.followUp({
      embeds: [ok("Language Updated!", `Your language is now set to **${userLang === "fr" ? "Français" : "English"}**.`)],
      ephemeral: true,
    });
    return;
  }

  // ── /categories ─────────────────────────────
  if (name === "categories") {
    await interaction.deferReply();
    const categoryKey = interaction.options.getString("category");
    const lang = getUserLang(interaction.user);

    const categorized = await getCategorizedStock(guild.id);

    if (categoryKey && DEFAULT_CATEGORIES[categoryKey]) {
      const cat = DEFAULT_CATEGORIES[categoryKey];
      const embed = new EmbedBuilder()
        .setTitle(`${cat.emoji} ${cat.name[lang] || cat.name.en}`)
        .setColor(C.info)
        .setTimestamp();

      const tiers = categorized[categoryKey] || {};
      for (const [tier, services] of Object.entries(tiers)) {
        const meta = TIER_META[tier] || TIER_META.free;
        const lines = services.map(s => `**${s.name}** — ${s.count}`).join("\n");
        if (lines) embed.addFields({ name: `${meta.emoji} ${meta.label}`, value: lines, inline: false });
      }

      await interaction.followUp({embeds:[embed]});
    } else {
      // Show all categories
      const embed = new EmbedBuilder()
        .setTitle(`📁 ${t("category", lang)}`)
        .setColor(C.info)
        .setTimestamp();

      for (const [key, cat] of Object.entries(DEFAULT_CATEGORIES)) {
        const tiers = categorized[key] || {};
        const totalServices = Object.values(tiers).flat().length;
        embed.addFields({
          name: `${cat.emoji} ${cat.name[lang] || cat.name.en}`,
          value: `**${totalServices}** services`,
          inline: true,
        });
      }

      await interaction.followUp({embeds:[embed]});
    }
    return;
  }

  // ── /ratecheck ──────────────────────────────
  if (name === "ratecheck") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});

    const target = interaction.options.getMember("member");
    const now = Date.now();
    const lang = getUserLang(interaction.user);

    const embed = new EmbedBuilder()
      .setTitle("🚦  Rate Limit Check")
      .setColor(C.info)
      .setTimestamp()
      .setThumbnail(target.user.displayAvatarURL());

    for (const tier of TIERS) {
      const limit = RATE_LIMITS.perUser;
      const used = (userRateLimits.get(target.id)?.perUser || []).filter(ts => now - ts < limit.period).length;
      const remaining = limit.max - used;
      embed.addFields({
        name: `${TIER_META[tier]?.emoji || "❓"} ${tier}`,
        value: `Used: **${used}**/${limit.max}\nRemaining: **${remaining}**`,
        inline: true,
      });
    }

    await interaction.followUp({embeds:[embed]});
    return;
  }

  // ── /restock ─────────────────────────────────
  if (name === "restock") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Access Denied","You do not have permission.")]});

    const t = interaction.options.getString("tier");
    const service = capitalize(interaction.options.getString("service"));
    const amount = interaction.options.getInteger("amount");
    const lang = getUserLang(interaction.user);

    await notifyRestock(guild, t, service, amount);

    await interaction.followUp({embeds:[ok(t("restocked", lang, {service, tier: t, count: amount}), `Notification sent to staff!`)]});
    return;
  }
}

// ── INTERNAL HTTP SERVER (server→bot bridge) ────

const botHttpServer = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/bot/create-ticket") {
    res.writeHead(404); res.end("Not found"); return;
  }
  if (req.headers["x-bot-secret"] !== BOT_SECRET) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", async () => {
    try {
      const { userId, username, service, tier, code, ticketId, guildId } = JSON.parse(body);

      // Wait for bot to be ready (max 15s)
      let waited = 0;
      while (!botReady && waited < 15000) {
        await new Promise(r => setTimeout(r, 300));
        waited += 300;
      }

      // Force fetch if not in cache
      let guild = client.guilds.cache.get(String(guildId));
      if (!guild) {
        try { guild = await client.guilds.fetch(String(guildId)); } catch(e) {
          console.error("guild.fetch error:", e.message);
        }
      }
      console.log(`[bot-bridge] guildId=${guildId} found=${!!guild} cacheSize=${client.guilds.cache.size}`);
      if (!guild) { res.writeHead(404); res.end(JSON.stringify({ error: `Guild ${guildId} not found. Cache size: ${client.guilds.cache.size}` })); return; }

      const cfg = getCfg(guildId);
      if (!cfg) { res.writeHead(404); res.end(JSON.stringify({ error: "Config not found" })); return; }
      if (!cfg.ticketCategory) { res.writeHead(400); res.end(JSON.stringify({ error: "ticketCategory not configured" })); return; }

      const meta = TIER_META[tier] || TIER_META.free;
      const name = `web-${service.toLowerCase()}-${username.toLowerCase().slice(0,10)}-${Math.floor(Math.random()*9000+1000)}`;

      let category = guild.channels.cache.get(cfg.ticketCategory);
      if (!category) {
        try { category = await guild.channels.fetch(cfg.ticketCategory); } catch(_) {}
      }
      if (!category) { res.writeHead(404); res.end(JSON.stringify({ error: `Category ${cfg.ticketCategory} not found. Check bot permissions.` })); return; }

      console.log(`[bot-bridge] creating channel in category=${cfg.ticketCategory}`);
      // Create channel — inherits category permissions
      const ticketCh = await guild.channels.create({
        name,
        parent: String(cfg.ticketCategory),
      });

      const SITE = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : (process.env.SITE_URL || "https://web-production-06585.up.railway.app");

      const embed = new EmbedBuilder()
        .setTitle("🌐  Web Generation Ticket")
        .setDescription(`**${username}** generated an account from the website.`)
        .setColor(meta.color)
        .addFields(
          { name: "👤 Member",    value: `**${username}**`,                              inline: true  },
          { name: "📦 Service",   value: `**${service}**`,                               inline: true  },
          { name: "🏷️ Tier",     value: `${meta.emoji} **${meta.label}**`,              inline: true  },
          { name: "🔑 Code",      value: `\`\`\`${code}\`\`\``,                         inline: false },
          { name: "📋 Command",  value: `\`/redeem ${code}\``,                          inline: false },
          { name: "🌐 Web Ticket",value: `${SITE}/ticket.html?id=${ticketId}`,           inline: false },
        )
        .setFooter({ text: "Gen Bot • Web Generation" })
        .setTimestamp();

      // Ping staff ONLY — member is on the website
      await ticketCh.send({ content: `<@&${cfg.staffRole}>`, embeds: [embed] });

      // Register channel → ticket mapping
      channelToTicket.set(ticketCh.id, ticketId);

      console.log(`✅ Bot created Discord ticket: ${ticketCh.id} (${ticketCh.name})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ channelId: ticketCh.id }));
    } catch (e) {
      console.error("Bot create-ticket error:", e);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });
});

export function startBot() {
  const BOT_HTTP_PORT = parseInt(process.env.BOT_HTTP_PORT || "3001");
  botHttpServer.listen(BOT_HTTP_PORT, "127.0.0.1", () => {
    console.log(`🔌 Bot HTTP bridge listening on :${BOT_HTTP_PORT}`);
  });
  if (process.env.TOKEN) {
    client.login(process.env.TOKEN).catch(e=>console.error("Bot login failed:", e.message));
  } else {
    console.log("No DISCORD_TOKEN found, skipping bot login (web-only mode)");
  }
}
