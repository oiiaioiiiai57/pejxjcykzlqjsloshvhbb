import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { readJson, writeJson, readLines, writeLines, listDir } from "./github.js";
import {
  GUILDS, getGuild, COOLDOWN_LIMITS, FILES, ACCOUNTS_DIR,
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
  SITE, BOT_SECRET, loadGuildConfig, getAccountsDir,
  DEFAULT_CATEGORIES, RATE_LIMITS, BACKUP_CONFIG, FEEDBACK_CONFIG,
} from "./config.js";
import crypto from "crypto";
import { fileURLToPath } from "url";
import path from "path";
import { discordSend, discordLog } from "./discord-api.js";
import { t, messages } from "./i18n.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── BOT BRIDGE ────────────────────────────────────────────────
// Le serveur demande au bot de créer le ticket via une route interne
async function createTicketViaBot({ userId, username, service, tier, code, ticketId, guildId }) {
  const res = await fetch(`http://localhost:${process.env.BOT_HTTP_PORT || 3001}/bot/create-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bot-Secret": BOT_SECRET },
    body: JSON.stringify({ userId, username, service, tier, code, ticketId, guildId }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Bot create-ticket ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data.channelId || null;
}

// ── EXPRESS SETUP ─────────────────────────────────────────────
const app    = express();
const server = createServer(app);

app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ── WEBSOCKET SERVER ──────────────────────────────────────────
const wss = new WebSocketServer({ server });

// { ticket_id: Set<ws> }
const ticketSockets = new Map();

function broadcastToTicket(ticketId, payload) {
  const sockets = ticketSockets.get(ticketId);
  if (!sockets) return;
  const msg = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

wss.on("connection", (ws, req) => {
  const url    = new URL(req.url, "http://x");
  const token  = url.searchParams.get("token");
  const ticketId = url.searchParams.get("ticket");

  if (!token || !ticketId) { ws.close(4001, "Missing params"); return; }

  // Verify session async
  getSession(token).then(session => {
    if (!session) { ws.close(4003, "Not logged in"); return; }

    // Auth check happens per ticket below
    getTicket(ticketId).then(ticket => {
      if (!ticket) { ws.close(4004, "Ticket not found"); return; }
      if (ticket.userId !== session.userId && !session.isStaff) {
        ws.close(4005, "Forbidden"); return;
      }

      ws._ticketId = ticketId;
      ws._session  = session;
      if (!ticketSockets.has(ticketId)) ticketSockets.set(ticketId, new Set());
      ticketSockets.get(ticketId).add(ws);

      ws.on("close", () => {
        ticketSockets.get(ticketId)?.delete(ws);
      });
    });
  });
});

// ── RUNTIME STATE ─────────────────────────────────────────────
// Sessions: Map<token, sessionData>  (backed by GitHub)
const sessionCache = new Map();

// Tickets: Map<ticketId, ticketData>  (backed by GitHub)
const ticketCache  = new Map();
let   ticketsLoaded = false;

// Channel → ticketId mapping for Discord bridge
export const channelToTicket = new Map(); // channelId → ticketId

// Cooldowns: Map<userId, Map<tier, timestamp[]>>
const cooldowns = new Map();

// ── SESSIONS ─────────────────────────────────────────────────
async function getSession(token) {
  if (!token) return null;
  if (sessionCache.has(token)) return sessionCache.get(token);
  const all = await readJson(FILES.sessions);
  if (all[token]) { sessionCache.set(token, all[token]); return all[token]; }
  return null;
}

async function setSession(token, data) {
  sessionCache.set(token, data);
  const all = await readJson(FILES.sessions);
  all[token] = data;
  await writeJson(FILES.sessions, all);
}

async function deleteSession(token) {
  sessionCache.delete(token);
  const all = await readJson(FILES.sessions);
  delete all[token];
  await writeJson(FILES.sessions, all);
}

// ── TICKETS ──────────────────────────────────────────────────
async function loadAllTickets() {
  if (ticketsLoaded) return;
  const all = await readJson(FILES.tickets);
  for (const [id, t] of Object.entries(all)) {
    ticketCache.set(id, t);
    if (t.discordChannelId && !t.closed) {
      channelToTicket.set(t.discordChannelId, id);
    }
  }
  ticketsLoaded = true;
}

async function getTicket(id) {
  await loadAllTickets();
  if (ticketCache.has(id)) return ticketCache.get(id);
  // fallback if not in memory (edge case)
  const all = await readJson(FILES.tickets);
  if (all[id]) { ticketCache.set(id, all[id]); return all[id]; }
  return null;
}

async function saveTicket(id) {
  const t   = ticketCache.get(id);
  if (!t) return;
  const all = await readJson(FILES.tickets);
  all[id]   = t;
  await writeJson(FILES.tickets, all);
}

// ── COOLDOWNS ─────────────────────────────────────────────────
// In-memory cooldowns (reset on restart is fine — Railway restarts ~every 9h)
// This is intentional: cooldowns are per-session, not permanent

function checkCooldown(userId, tier) {
  if (!COOLDOWN_LIMITS[tier]) return { ok: true };
  const now      = Date.now();
  const { max, period } = COOLDOWN_LIMITS[tier];
  const periodMs = period * 1000;

  if (!cooldowns.has(userId)) cooldowns.set(userId, new Map());
  const userCd = cooldowns.get(userId);
  if (!userCd.has(tier)) userCd.set(tier, []);
  const bucket = userCd.get(tier).filter(ts => now - ts < periodMs);
  userCd.set(tier, bucket);

  if (bucket.length >= max) {
    const wait = Math.ceil((periodMs - (now - bucket[0])) / 1000);
    return { ok: false, wait };
  }
  bucket.push(now);
  return { ok: true };
}

// ── OAUTH2 ────────────────────────────────────────────────────
function getUserTierForGuild(roleIds, guildCfg) {
  const set = new Set(roleIds);
  const tr  = guildCfg.tierRoles || {};
  if ((tr.extreme||[]).some(r => set.has(r)))  return "extreme";
  if ((tr.booster||[]).some(r => set.has(r)))  return "booster";
  if ((tr.premium||[]).some(r => set.has(r)))  return "premium";
  if ((tr.free||[]).some(r => set.has(r)))     return "free";
  return null;
}

async function getUserInfoFromGuilds(accessToken) {
  for (const [guildId, cfg] of Object.entries(GUILDS)) {
    const res = await fetch(
      `https://discord.com/api/users/@me/guilds/${guildId}/member`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) continue;
    const data    = await res.json();
    const roleIds = data.roles || [];
    const tier    = getUserTierForGuild(roleIds, cfg);
    const isStaff = roleIds.includes(cfg.staffRoleId);
    if (tier || isStaff) return { guildId, tier, isStaff };
  }
  return { guildId: null, tier: null, isStaff: false };
}

app.get("/auth/login", (req, res) => {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id",    DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type","code");
  url.searchParams.set("scope",        "identify guilds.members.read");
  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${SITE}?error=no_code`);

  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) return res.redirect(`${SITE}?error=token_failed`);
    const { access_token } = await tokenRes.json();

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const user = await userRes.json();

    const { guildId, tier, isStaff, guilds } = await getUserInfoFromGuilds(access_token);
    if (!guildId) return res.redirect(`${SITE}?error=not_in_server`);

    const token = crypto.randomBytes(32).toString("hex");
    await setSession(token, {
      userId:    user.id,
      username:  user.username,
      avatar:    user.avatar || null,
      tier,
      isStaff,
      guildId,
      guilds:    guilds || [],
      createdAt: new Date().toISOString(),
    });

    res.redirect(`${SITE}?token=${token}`);
  } catch (e) {
    console.error("Auth callback error:", e);
    res.redirect(`${SITE}?error=server_error`);
  }
});

app.get("/auth/me", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.query.token;
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  res.json(session);
});

app.post("/auth/logout", async (req, res) => {
  const token = req.headers["x-session-token"];
  if (token) await deleteSession(token);
  res.json({ ok: true });
});

// ── SWITCH GUILD ─────────────────────────────────────────────
app.post("/api/switch-guild", async (req, res) => {
  const token   = req.headers["x-session-token"];
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: "Not logged in" });

  const { guildId } = req.body;
  const guild = session.guilds?.find(g => g.guildId === guildId);
  if (!guild) return res.status(403).json({ error: "You are not in this server." });

  // Update session with new guild
  session.guildId  = guild.guildId;
  session.tier     = guild.tier;
  session.isStaff  = guild.isStaff;
  await setSession(token, session);

  res.json({ ok: true, guildId: guild.guildId, tier: guild.tier, isStaff: guild.isStaff, guildName: guild.guildName });
});

// ── STOCK ─────────────────────────────────────────────────────
app.get("/api/stock", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.query.token;
  const session = token ? await getSession(token) : null;
  // Use session guildId if logged in, else default to first guild
  const guildId = session?.guildId || Object.keys(GUILDS)[0];
  const acDir   = getAccountsDir(guildId);

  const tiers  = ["free", "premium", "booster", "extreme"];
  const result = {};
  let   total  = 0;
  for (const tier of tiers) {
    const files    = await listDir(`${acDir}/${tier}`);
    const services = [];
    for (const f of files) {
      if (!f.name.endsWith(".txt")) continue;
      const lines = await readLines(f.path);
      total += lines.length;
      services.push({ name: f.name.replace(".txt",""), count: lines.length });
    }
    result[tier] = services.sort((a,b) => a.name.localeCompare(b.name));
  }
  res.json({ tiers: result, total, guildId, guildName: GUILDS[guildId]?.name });
});

// ── GEN ───────────────────────────────────────────────────────
app.post("/api/gen", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.body.token;
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: "Not logged in" });

  const { userId, username, isStaff, guildId, tier: userTier } = session;
  if (!userTier) return res.status(403).json({ error: "You do not have the required role." });

  const reqTier = (req.body.tier || "").toLowerCase();
  const service = (req.body.service || "").trim();
  if (!service) return res.status(400).json({ error: "Service required." });
  if (!["free","premium","booster","extreme"].includes(reqTier))
    return res.status(400).json({ error: "Invalid tier." });

  const allowed = { free:["free"], premium:["free","premium"], booster:["free","premium","booster"], extreme:["free","premium","booster","extreme"] };
  if (!allowed[userTier].includes(reqTier))
    return res.status(403).json({ error: `Your role only allows the ${userTier} tier.` });

  if (!isStaff) {
    const cd = checkCooldown(userId, reqTier);
    if (!cd.ok) {
      const m = Math.floor(cd.wait / 60), s = cd.wait % 60;
      return res.status(429).json({ error: `Cooldown! Try again in ${m}m ${s}s.` });
    }
  }

  const svcNorm = service.charAt(0).toUpperCase() + service.slice(1).toLowerCase();
  const acDir   = getAccountsDir(guildId);
  const path    = `${acDir}/${reqTier}/${svcNorm}.txt`;
  const stock   = await readLines(path);
  if (!stock.length) return res.status(404).json({ error: `Out of stock for ${svcNorm} (${reqTier})` });

  const account  = stock.shift();
  await writeLines(path, stock);

  const code     = crypto.randomBytes(3).toString("hex").toUpperCase();
  const ticketId = crypto.randomBytes(12).toString("hex");

  // Save pending for /redeem
  const pending  = await readJson(FILES.pending);
  pending[code]  = { account, user: userId, webTicketId: ticketId, tier: reqTier, service: svcNorm };
  await writeJson(FILES.pending, pending);

  // Demander au bot de créer le ticket Discord (il a les bonnes permissions)
  let discordChannelId = null;
  try {
    const botRes = await createTicketViaBot({
      userId, username, service: svcNorm, tier: reqTier,
      code, ticketId, guildId,
    });
    if (botRes) {
      discordChannelId = botRes;
      channelToTicket.set(discordChannelId, ticketId);
      console.log(`✅ Discord ticket created: ${discordChannelId}`);
    }
  } catch (e) {
    console.error("Discord ticket create error:", e.message);
  }

  // Store ticket
  await loadAllTickets();
  const ticket = {
    userId, username, service: svcNorm, tier: reqTier,
    code, account,
    discordChannelId,
    guildId,
    redeemed: false,
    closed:   false,
    messages: [],
    createdAt: new Date().toISOString(),
  };
  ticketCache.set(ticketId, ticket);
  await saveTicket(ticketId);

  // Save to genlog (no account yet — revealed after redeem)
  const genlog = await readJson(FILES.genlog);
  if (!genlog[userId]) genlog[userId] = [];
  genlog[userId].unshift({ ticketId, service: svcNorm, tier: reqTier, date: new Date().toISOString(), account: null });
  if (genlog[userId].length > 50) genlog[userId].length = 50;
  await writeJson(FILES.genlog, genlog);

  // Stats — count web gen per user (same format as Discord bot)
  const stats = await readJson(FILES.stats);
  stats.web_gens = (stats.web_gens || 0) + 1;
  stats[userId] = (stats[userId] || 0) + 1;
  const tierKey = userId + "_tiers";
  stats[tierKey] = stats[tierKey] || {};
  stats[tierKey][reqTier] = (stats[tierKey][reqTier] || 0) + 1;
  await writeJson(FILES.stats, stats);

  // Discord log
  try {
    await discordLog(guildCfg.logChannel, {
      title: "📝 Web Generation",
      description: `**${username}** a gen **${svcNorm}** (${reqTier})`,
      color: 0x5865F2,
      timestamp: new Date().toISOString(),
    });
  } catch {}

  res.json({ ticketId, service: svcNorm, tier: reqTier });
});

// ── TICKET API ────────────────────────────────────────────────
async function authTicket(req, res) {
  const token   = req.headers["x-session-token"] || req.query.token;
  const session = await getSession(token);
  if (!session) { res.status(401).json({ error: "Not logged in" }); return null; }
  const ticket  = await getTicket(req.params.id);
  if (!ticket)  { res.status(404).json({ error: "Ticket not found" }); return null; }
  if (ticket.userId !== session.userId && !session.isStaff) {
    res.status(403).json({ error: "Forbidden" }); return null;
  }
  return { session, ticket };
}

app.get("/api/ticket/:id", async (req, res) => {
  const auth = await authTicket(req, res);
  if (!auth) return;
  const { ticket } = auth;
  res.json({
    ticketId:  req.params.id,
    service:   ticket.service,
    tier:      ticket.tier,
    code:      ticket.code,
    redeemed:  ticket.redeemed,
    closed:    ticket.closed,
    account:   ticket.redeemed ? ticket.account : null,
    createdAt: ticket.createdAt,
  });
});

app.get("/api/ticket/:id/messages", async (req, res) => {
  const auth = await authTicket(req, res);
  if (!auth) return;
  const { ticket } = auth;
  const after = parseInt(req.query.after || "0");
  res.json({
    messages: ticket.messages.filter(m => m.id > after),
    redeemed: ticket.redeemed,
    closed:   ticket.closed,
    account:  ticket.redeemed ? ticket.account : null,
  });
});

app.post("/api/ticket/:id/messages", async (req, res) => {
  const auth = await authTicket(req, res);
  if (!auth) return;
  const { session, ticket } = auth;
  if (ticket.closed) return res.status(400).json({ error: "Ticket fermé." });

  const content = (req.body.content || "").trim().slice(0, 500);
  if (!content) return res.status(400).json({ error: "Message vide." });

  const msgId = (ticket.messages.at(-1)?.id || 0) + 1;
  const msg = {
    id:         msgId,
    content,
    authorType: session.isStaff ? "staff" : "member",
    authorName: session.username,
    timestamp:  new Date().toISOString(),
  };
  ticket.messages.push(msg);

  // Broadcast via WebSocket
  broadcastToTicket(req.params.id, { type: "message", msg, redeemed: ticket.redeemed, closed: ticket.closed });

  // Bridge to Discord
  if (ticket.discordChannelId) {
    const color = session.isStaff ? 0x5865F2 : 0x39e07a;
    discordSend(ticket.discordChannelId, { embeds: [{
      description: content,
      color,
      author: { name: `${session.isStaff ? "🛡️" : "👤"} ${session.username} (web)` },
      timestamp: msg.timestamp,
    }]}).catch(console.error);
  }

  res.json({ ok: true, msg });
});

app.post("/api/ticket/:id/close", async (req, res) => {
  const token   = req.headers["x-session-token"];
  const session = await getSession(token);
  if (!session?.isStaff) return res.status(403).json({ error: "Staff only." });
  const ticket  = await getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Not found." });

  ticket.closed = true;
  await saveTicket(req.params.id);

  // Broadcast close via WS
  broadcastToTicket(req.params.id, { type: "closed" });

  // Notify + delete Discord channel
  if (ticket.discordChannelId) {
    discordSend(ticket.discordChannelId, { embeds: [{
      title: "🔒 Ticket fermé depuis le site",
      color: 0xED4245,
      footer: { text: `Fermé par ${session.username}` },
      timestamp: new Date().toISOString(),
    }]}).then(() => setTimeout(() =>
      fetch(`https://discord.com/api/v10/channels/${ticket.discordChannelId}`, {
        method: "DELETE", headers: { Authorization: `Bot ${process.env.TOKEN}` }
      }), 5000)
    ).catch(console.error);
  }

  res.json({ ok: true });
});

// ── INTERNAL (called by Discord bot) ─────────────────────────
function requireBot(req, res) {
  if (req.headers["x-bot-secret"] !== BOT_SECRET) {
    res.status(403).json({ error: "Forbidden" }); return false;
  }
  return true;
}

// Bot tells us a ticket was redeemed (/redeem command)
app.post("/internal/ticket/:id/redeem", async (req, res) => {
  if (!requireBot(req, res)) return;
  const ticket = await getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Not found" });

  const account     = req.body.account || ticket.account;
  ticket.redeemed   = true;
  ticket.account    = account;
  await saveTicket(req.params.id);

  // Update genlog with actual account
  try {
    const genlog = await readJson(FILES.genlog);
    const uid    = ticket.userId;
    if (genlog[uid]) {
      const entry = genlog[uid].find(e => e.ticketId === req.params.id);
      if (entry) { entry.account = account; await writeJson(FILES.genlog, genlog); }
    }
  } catch (e) { console.error("genlog update failed:", e.message); }

  // Push to WebSocket clients
  broadcastToTicket(req.params.id, { type: "redeemed", account });

  res.json({ ok: true });
});

// Bot tells us a ticket was closed (/close command)
app.post("/internal/ticket/:id/close", async (req, res) => {
  if (!requireBot(req, res)) return;
  const ticket = await getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Not found" });
  ticket.closed = true;
  await saveTicket(req.params.id);
  broadcastToTicket(req.params.id, { type: "closed" });
  if (ticket.discordChannelId) channelToTicket.delete(ticket.discordChannelId);
  res.json({ ok: true });
});

// Bot bridges a Discord message to the web ticket
app.post("/internal/ticket/:id/message", async (req, res) => {
  if (!requireBot(req, res)) return;
  const ticket = await getTicket(req.params.id);
  if (!ticket) return res.json({ ok: true });
  const content = (req.body.content || "").trim().slice(0, 500);
  if (!content) return res.json({ ok: true });
  const msgId = (ticket.messages.at(-1)?.id || 0) + 1;
  const msg = {
    id:         msgId,
    content,
    authorType: "staff",
    authorName: req.body.author || "Staff",
    timestamp:  new Date().toISOString(),
  };
  ticket.messages.push(msg);
  broadcastToTicket(req.params.id, { type: "message", msg, redeemed: ticket.redeemed, closed: ticket.closed });
  res.json({ ok: true });
});

// Bot fetches the channel→ticket mapping on startup
app.get("/internal/tickets_map", async (req, res) => {
  if (!requireBot(req, res)) return;
  await loadAllTickets();
  const map = {};
  for (const [chId, tid] of channelToTicket.entries()) map[chId] = tid;
  res.json(map);
});

// ── PROFILE ──────────────────────────────────────────────────
app.get("/api/profile", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.query.token;
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  const genlog  = await readJson(FILES.genlog);
  res.json({ ...session, genHistory: genlog[session.userId] || [] });
});

// ── FEEDBACK API ───────────────────────────────────────
app.post("/api/feedback", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.body.token;
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: "Not logged in" });

  const { rating, comment, service, tier } = req.body;
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Invalid rating (must be 1-5)" });
  }

  const feedback = await readJson(FILES.feedback);
  if (!feedback[session.userId]) feedback[session.userId] = [];
  feedback[session.userId].push({
    rating,
    comment: comment || "",
    service: service || "",
    tier: tier || "",
    date: new Date().toISOString(),
  });
  await writeJson(FILES.feedback, feedback);

  res.json({ ok: true });
});

app.get("/api/feedback/stats", async (req, res) => {
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

  res.json({
    average: count > 0 ? (totalRating / count).toFixed(2) : 0,
    total: count,
    serviceRatings,
  });
});

// ── CATEGORIES API ────────────────────────────────────
app.get("/api/categories", async (req, res) => {
  const lang = req.query.lang || "en";
  const categories = {};

  for (const [key, cat] of Object.entries(DEFAULT_CATEGORIES)) {
    categories[key] = {
      name: cat.name[lang] || cat.name.en,
      emoji: cat.emoji,
      services: cat.services,
    };
  }

  res.json({ categories });
});

app.get("/api/categories/:category/services", async (req, res) => {
  const { category } = req.params;
  const lang = req.query.lang || "en";

  if (!DEFAULT_CATEGORIES[category]) {
    return res.status(404).json({ error: "Category not found" });
  }

  const cat = DEFAULT_CATEGORIES[category];
  const token   = req.headers["x-session-token"] || req.query.token;
  const session = token ? await getSession(token) : null;
  const guildId = session?.guildId || Object.keys(GUILDS)[0];
  const acDir   = getAccountsDir(guildId);

  const services = [];
  for (const serviceName of cat.services) {
    for (const tier of ["free", "premium", "booster", "extreme"]) {
      try {
        const filePath = `${acDir}/${tier}/${serviceName}.txt`;
        const lines = await readLines(filePath);
        if (lines.length > 0) {
          services.push({ name: serviceName, tier, count: lines.length });
        }
      } catch (_) {}
    }
  }

  res.json({
    category: cat.name[lang] || cat.name.en,
    emoji: cat.emoji,
    services,
  });
});

// ── LANGUAGE PREFERENCE ─────────────────────────────
app.post("/api/language", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.body.token;
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: "Not logged in" });

  const { lang } = req.body;
  if (!["en", "fr"].includes(lang)) {
    return res.status(400).json({ error: "Invalid language" });
  }

  const langPrefs = await readJson("lang_prefs.json").catch(() => ({}));
  langPrefs[session.userId] = lang;
  await writeJson("lang_prefs.json", langPrefs);

  res.json({ ok: true, lang });
});

app.get("/api/language", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.query.token;
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: "Not logged in" });

  const langPrefs = await readJson("lang_prefs.json").catch(() => ({}));
  res.json({ lang: langPrefs[session.userId] || "en" });
});

// ── BACKUP API ────────────────────────────────────────
app.post("/api/backup", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.body.token;
  const session = await getSession(token);
  if (!session?.isStaff) return res.status(403).json({ error: "Staff only" });

  try {
    // Dynamic import to avoid circular dependency
    const { performBackup } = await import("./bot.js");
    await performBackup();
    res.json({ ok: true, message: "Backup completed" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/backups", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.query.token;
  const session = await getSession(token);
  if (!session?.isStaff) return res.status(403).json({ error: "Staff only" });

  const backups = await readJson(FILES.backups);
  res.json({ backups: backups || [] });
});

// ── SEARCH API ───────────────────────────────────────
app.get("/api/search", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.query.token;
  const session = await getSession(token);
  if (!session?.isStaff) return res.status(403).json({ error: "Staff only" });

  const { query, tier } = req.query;
  if (!query) return res.status(400).json({ error: "Query required" });

  const acDir = getAccountsDir(session.guildId);
  const tiers = tier ? [tier] : ["free", "premium", "booster", "extreme"];
  const results = [];

  for (const t of tiers) {
    try {
      const files = await listDir(`${acDir}/${t}`);
      for (const f of files) {
        if (!f.name.endsWith(".txt")) continue;
        const service = f.name.replace(".txt", "");
        if (service.toLowerCase().includes(query.toLowerCase())) {
          const lines = await readLines(f.path);
          results.push({
            tier: t,
            service,
            count: lines.length,
            preview: lines.slice(0, 3),
          });
        }
      }
    } catch (_) {}
  }

  res.json({ results });
});

// ── RATE LIMIT CHECK API ─────────────────────────────
app.get("/api/rate-limit/:userId", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.query.token;
  const session = await getSession(token);
  if (!session?.isStaff) return res.status(403).json({ error: "Staff only" });

  const { userId } = req.params;
  const now = Date.now();

  const limits = {};
  for (const tier of ["free", "premium", "booster", "extreme"]) {
    const config = RATE_LIMITS.perUser;
    const used = (cooldowns.get(userId)?.perUser || []).filter(ts => now - ts < config.period).length;
    limits[tier] = {
      used,
      max: config.max,
      remaining: config.max - used,
    };
  }

  res.json({ userId, limits });
});

// ── ANNOUNCEMENT API ────────────────────────────────
app.post("/api/announce", async (req, res) => {
  const token   = req.headers["x-session-token"] || req.body.token;
  const session = await getSession(token);
  if (!session?.isStaff) return res.status(403).json({ error: "Staff only" });

  const { message, sendDM } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  try {
    // Dynamic import to avoid circular dependency
    const { announceToAll } = await import("./bot.js");
    const sentCount = await announceToAll(session.guildId, message, sendDM !== false);
    res.json({ ok: true, sentCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATS (Enhanced) ─────────────────────────────────────────────
app.get("/api/stats", async (req, res) => {
  const stats = await readJson(FILES.stats);
  const total = Object.entries(stats)
    .filter(([k,v]) => /^\d+$/.test(k) && typeof v === "number")
    .reduce((s,[,v]) => s+v, 0);
  res.json({ total_gens: total, web_gens: stats.web_gens || 0 });
});

// Explicit HTML routes so Railway doesn't 404
app.get("/profile.html", (_req, res) => res.sendFile(path.join(__dirname,"../public/profile.html")));
app.get("/ticket.html",  (_req, res) => res.sendFile(path.join(__dirname,"../public/ticket.html")));

// SPA fallback
app.get("*", (_req, res) => {
  if (!_req.path.startsWith("/api") && !_req.path.startsWith("/auth") && !_req.path.startsWith("/internal")) {
    res.sendFile(path.join(__dirname,"../public/index.html"));
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── START ─────────────────────────────────────────────────────
export { server };
export function startServer() {
  const PORT = parseInt(process.env.PORT || "8080");
  server.listen(PORT, () => console.log(`🌐 Server + WS listening on :${PORT}`));
}
