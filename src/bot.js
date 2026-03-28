import {
  Client, GatewayIntentBits, Partials, Events,
  SlashCommandBuilder, EmbedBuilder, PermissionsBitField,
  REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { readJson, writeJson, readLines, writeLines, listDir } from "./github.js";
import { GUILDS, FILES, ACCOUNTS_DIR, BOT_SECRET, TIERS, TIER_META,
         COOLDOWN_LIMITS, loadGuildConfig, getGuild, getAccountsDir } from "./config.js";
import { channelToTicket } from "./server.js";
import crypto from "crypto";
import http from "http";

const BACKEND = process.env.BACKEND_URL || "https://pejxjcykzlqjsloshvhbb-production.up.railway.app";

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
const C = { success:0x57F287, error:0xED4245, warn:0xFEE75C, info:0x5865F2, log:0x2B2D31 };

const ok   = (t,d) => new EmbedBuilder().setTitle(`✅  ${t}`).setDescription(d||null).setColor(C.success).setFooter({text:"Gen Bot"});
const err  = (t,d) => new EmbedBuilder().setTitle(`❌  ${t}`).setDescription(d||null).setColor(C.error).setFooter({text:"Gen Bot"});
const warn = (t,d) => new EmbedBuilder().setTitle(`⚠️  ${t}`).setDescription(d||null).setColor(C.warn).setFooter({text:"Gen Bot"});
const log  = (t,d) => new EmbedBuilder().setTitle(t).setDescription(d||null).setColor(C.log).setTimestamp();

function getCfg(guildId) { return getGuild(guildId); }
function getServerTiers(guildId) {
  // Both servers now have free/premium/booster/extreme
  return TIERS;
}
function isMod(m)    { const c=getCfg(m.guild.id); return c?.modRoles.some(r=>m.roles.cache.has(r))||false; }
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

const commands = [
  new SlashCommandBuilder().setName("gen").setDescription("Generate an account")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service name (e.g. Netflix)").setRequired(true)),

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

  new SlashCommandBuilder().setName("rvoutch").setDescription("[Admin] Remove vouches from a member")
    .addUserOption(o=>o.setName("member").setDescription("Target").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("promote").setDescription("View vouch progress")
    .addUserOption(o=>o.setName("member").setDescription("Target (empty = yourself)")),

  new SlashCommandBuilder().setName("stock").setDescription("View available stock")
    .addStringOption(o=>o.setName("tier").setDescription("Filter by tier").addChoices(...TIER_CHOICES)),

  new SlashCommandBuilder().setName("profile").setDescription("View a profile")
    .addUserOption(o=>o.setName("member").setDescription("Target (empty = yourself)")),

  new SlashCommandBuilder().setName("leaderboard").setDescription("Top 10 generators"),

  new SlashCommandBuilder().setName("add").setDescription("[Staff] Add accounts")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addAttachmentOption(o=>o.setName("file").setDescription(".txt file").setRequired(true)),

  new SlashCommandBuilder().setName("remove").setDescription("[Mod] Remove accounts from stock")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("send").setDescription("[Staff] Send accounts via DM")
    .addUserOption(o=>o.setName("member").setDescription("Target").setRequired(true))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

new SlashCommandBuilder().setName("help").setDescription("List all commands"),
  new SlashCommandBuilder().setName("verify").setDescription("Start the verification process"),
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
  client.user.setActivity("https://pejxjcykzlqjsloshvhbb-production.up.railway.app", {type: 3}); // type 3 = Watching
  await loadGuildConfig();
  await migrateAccounts();
  await registerCommands();
  await loadGiveaways();

  // Send stock report immediately + every hour
  setTimeout(async () => {
    await sendHourlyStockReport();
    setInterval(sendHourlyStockReport, 60 * 60 * 1000);
  }, 5000); // wait 5s for cache to populate
  try {
    const res = await fetch(`${BACKEND}/internal/tickets_map`,{headers:{"X-Bot-Secret":BOT_SECRET}});
    if (res.ok) {
      const map = await res.json();
      for (const [tid,chId] of Object.entries(map)) channelToTicket.set(String(chId),String(tid));
      console.log(`✅ Restored ${Object.keys(map).length} ticket mappings`);
    }
  } catch(e) { console.warn("Could not restore ticket map:", e.message); }
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

// ── MESSAGE BRIDGE ────────────────────────────────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  const tid = channelToTicket.get(String(message.channel.id));
  if (!tid) return;
  await notifyBackend(`/internal/ticket/${tid}/message`,{
    content:message.content, author:message.author.displayName||message.author.username,
  });
});

// ── INTERACTIONS ──────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
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
      const meta = TIER_META[t]||TIER_META.free;
      // Send as .txt file attachment
      const { AttachmentBuilder } = await import("discord.js");
      const fileBuffer = Buffer.from(account, "utf8");
      const attachment = new AttachmentBuilder(fileBuffer, { name: `${service}.txt` });
      const dmEmbed = new EmbedBuilder()
        .setTitle("📦  Your Account is Ready!")
        .setDescription("Your account file is attached below.\n**Do not share this with anyone!**")
        .setColor(meta.color)
        .addFields({name:"📦 Service", value:`**${service}**`, inline:true}, {name:"🏷️ Tier", value:`${meta.emoji} **${meta.label}**`, inline:true})
        .setTimestamp();
      await target.send({embeds:[dmEmbed], files:[attachment]}).catch(()=>{});
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
      .setTitle("🎟️  Generation Ticket")
      .setColor(meta.color)
      .addFields(
        { name:"👤 Member",   value:interaction.user.toString(), inline:true },
        { name:"📦 Service",  value:`**${service}**`,            inline:true },
        { name:"🏷️ Tier",    value:`${meta.emoji} **${meta.label}**`, inline:true },
        { name:"🔑 Code",     value:`\`\`\`${code}\`\`\``,       inline:false },
        { name:"📋 Command", value:`\`/redeem ${code}\``,        inline:false },
      )
      .setFooter({ text:`Remaining stock: ${stock.length}` }).setTimestamp();

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
    const service = capitalize(interaction.options.getString("service"));
    const acDirRall = getAccountsDir(guild.id);
    const path = `${acDirRall}/${t}/${service}.txt`;
    const stock = await readLines(path);
    if (!stock.length) return interaction.followUp({embeds:[err("Empty","This service has no stock.")]});
    await writeLines(path, []);
    await interaction.followUp({embeds:[ok("Cleared!",`**${stock.length}** accounts removed from \`${t}/${service}\`.`)]});
    await sendLog(guild, log("🗑️ Stock Cleared",`${interaction.user} cleared \`${t}/${service}\` (${stock.length} accounts removed)`).setColor(C.error));
    return;
  }

  // ── /web ──────────────────────────────────────────
  if (name === "web") {
    const SITE = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : (process.env.SITE_URL || "https://pejxjcykzlqjsloshvhbb-production.up.railway.app");
    const embed = new EmbedBuilder()
      .setTitle("🌐  Gen Bot — Website")
      .setDescription(`Click the link below to access the website:

**[${SITE}](${SITE})**`)
      .setColor(0x6366f1)
      .setFooter({text:"Gen Bot"})
      .setTimestamp();
    await interaction.reply({embeds:[embed]});
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
    if (!file.name.endsWith(".txt")) return interaction.followUp({embeds:[err("Invalid File","Only .txt files are accepted.")]});
    const res=await fetch(file.url); const text=await res.text();
    const lines=text.split("\n").map(l=>l.trim()).filter(Boolean);
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
        for (let i=0;i<accs.length;i+=10) {
          await target.send({embeds:[new EmbedBuilder().setTitle(`📦 ${service} (${TIER_META[t].label})`).setDescription("```\n"+accs.slice(i,i+10).join("\n")+"\n```").setColor(TIER_META[t].color).setTimestamp()]}).catch(()=>{});
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
    const embed=new EmbedBuilder().setTitle("📜  Commands — Gen Bot").setColor(C.info)
      .addFields(
        {name:"👥  Members",  value:"`/gen` `/profile` `/promote` `/leaderboard` `/stock`",inline:false},
        {name:"🛡️  Staff",   value:"`/redeem` `/close` `/giveaway` `/add` `/send` `/remove` `/addv` `/rvoutch` `/rall`",inline:false},
        {name:"ℹ️  Info",     value:"`/web`",inline:false},
        {name:"🏷️  Tiers",   value:TIERS.map(t=>`${TIER_META[t].emoji} \`${t}\``).join(" · "),inline:false},
      ).setFooter({text:"Gen Bot"}).setTimestamp();
    await interaction.reply({embeds:[embed]});
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
        : (process.env.SITE_URL || "https://pejxjcykzlqjsloshvhbb-production.up.railway.app");

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
  client.login(process.env.TOKEN).catch(e=>console.error("Bot login failed:", e.message));
}
