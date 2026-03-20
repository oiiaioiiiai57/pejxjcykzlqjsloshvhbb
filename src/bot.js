import {
  Client, GatewayIntentBits, Partials, Events,
  SlashCommandBuilder, EmbedBuilder, PermissionsBitField,
  REST, Routes, Collection, AttachmentBuilder,
} from "discord.js";
import { readJson, writeJson, readLines, writeLines, listDir } from "./github.js";
import { GUILDS, FILES, ACCOUNTS_DIR, BOT_SECRET, loadGuildConfig, getGuild } from "./config.js";
import { handlePanel } from "./panel.js";
import { channelToTicket } from "./server.js";
import crypto from "crypto";

const BACKEND = process.env.BACKEND_URL || "https://pejxjcykzlqjsloshvhbb-production.up.railway.app";

// ── BOT INIT ──────────────────────────────────────────────────
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ── HELPERS ───────────────────────────────────────────────────
const C = {
  success: 0x57F287, error: 0xED4245, warn: 0xFEE75C, info: 0x5865F2,
  log: 0x2B2D31, free: 0x57F287, premium: 0xA855F7, paid: 0xFFD166,
};
const TIER_COLOR = { free: C.free, premium: C.premium, paid: C.paid };
const TIER_EMOJI = { free: "🟢", premium: "🟣", paid: "🟡" };

const ok  = (t,d) => new EmbedBuilder().setTitle(`✅  ${t}`).setDescription(d||null).setColor(C.success).setFooter({text:"Gen Bot"});
const err = (t,d) => new EmbedBuilder().setTitle(`❌  ${t}`).setDescription(d||null).setColor(C.error).setFooter({text:"Gen Bot"});
const warn= (t,d) => new EmbedBuilder().setTitle(`⚠️  ${t}`).setDescription(d||null).setColor(C.warn).setFooter({text:"Gen Bot"});
const log = (t,d) => new EmbedBuilder().setTitle(t).setDescription(d||null).setColor(C.log).setTimestamp();

function getCfg(guildId) { return getGuild(guildId); }
function isMod(member) {
  const cfg = getCfg(member.guild.id);
  return cfg?.modRoles.some(r => member.roles.cache.has(r)) || false;
}
function isHelper(member) {
  const cfg = getCfg(member.guild.id);
  return member.roles.cache.has(cfg?.helperRole) || false;
}
function isStaff(member) { return isMod(member) || isHelper(member); }
function hasAddv(member) {
  const cfg = getCfg(member.guild.id);
  return member.roles.cache.has(cfg?.addvRole) || false;
}

async function sendLog(guild, embed) {
  const cfg = getCfg(guild.id);
  if (!cfg) return;
  const ch  = guild.channels.cache.get(cfg.logChannel);
  if (ch) await ch.send({ embeds: [embed] }).catch(console.error);
}

// Cooldowns in memory (separate from server.js)
const botCooldowns = new Map();

function checkBotCooldown(userId, tier) {
  const now    = Date.now();
  const limits = { free:[1,3600], premium:[3,3600], paid:[10,3600] };
  const [max, period] = limits[tier];
  const key    = `${userId}:${tier}`;
  const bucket = (botCooldowns.get(key) || []).filter(ts => now - ts < period*1000);
  if (bucket.length >= max) return { ok: false, wait: Math.ceil((period*1000 - (now - bucket[0]))/1000) };
  bucket.push(now); botCooldowns.set(key, bucket);
  return { ok: true };
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

async function getVouches(uid) {
  const data = await readJson(FILES.vouches);
  return data[String(uid)] || 0;
}
async function addVouch(uid, amount = 1) {
  const data = await readJson(FILES.vouches);
  data[String(uid)] = (data[String(uid)] || 0) + amount;
  await writeJson(FILES.vouches, data);
  return data[String(uid)];
}

async function checkAndPromote(guild, member, vouches) {
  const cfg = getCfg(guild.id);
  if (!cfg) return;
  for (const { threshold, roles } of cfg.vouchTiers) {
    if (vouches >= threshold) {
      const newly = [];
      for (const rid of roles) {
        if (!member.roles.cache.has(rid)) {
          await member.roles.add(rid).catch(console.error);
          newly.push(rid);
        }
      }
      if (newly.length) {
        const mentions = newly.map(r => `<@&${r}>`).join(" ");
        const l = log("🎉  Promotion", `${member} → ${mentions} avec **${vouches} vouches**!`);
        l.setColor(C.premium);
        await sendLog(guild, l);
      }
    }
  }
}

async function notifyBackend(path, body = {}) {
  return fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bot-Secret": BOT_SECRET },
    body: JSON.stringify(body),
  }).catch(e => console.error(`Backend notify ${path} failed:`, e.message));
}

// ── SLASH COMMANDS ────────────────────────────────────────────
const TIER_CHOICES = [
  { name: "🟢 Free",    value: "free"    },
  { name: "🟣 Premium", value: "premium" },
  { name: "🟡 Paid",    value: "paid"    },
];

const commands = [
  new SlashCommandBuilder()
    .setName("gen").setDescription("Generate an account")
    .addStringOption(o => o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o => o.setName("service").setDescription("Service name (ex: Netflix)").setRequired(true)),

  new SlashCommandBuilder()
    .setName("redeem").setDescription("[Staff] Validate a ticket")
    .addStringOption(o => o.setName("code").setDescription("Claim code").setRequired(true)),

  new SlashCommandBuilder()
    .setName("close").setDescription("[Staff] Close a ticket"),

  new SlashCommandBuilder()
    .setName("addv").setDescription("[Admin] Add vouches")
    .addUserOption(o => o.setName("member").setDescription("Target").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName("promote").setDescription("View vouch progress")
    .addUserOption(o => o.setName("member").setDescription("Target (empty = you)")),

  new SlashCommandBuilder()
    .setName("stock").setDescription("View stock")
    .addStringOption(o => o.setName("tier").setDescription("Filter tier").addChoices(...TIER_CHOICES)),

  new SlashCommandBuilder()
    .setName("profile").setDescription("View profile stats")
    .addUserOption(o => o.setName("member").setDescription("Target (empty = you)")),

  new SlashCommandBuilder()
    .setName("leaderboard").setDescription("Top 10 generators"),

  new SlashCommandBuilder()
    .setName("add").setDescription("[Staff] Add accounts")
    .addStringOption(o => o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o => o.setName("service").setDescription("Service name").setRequired(true))
    .addAttachmentOption(o => o.setName("file").setDescription(".txt file").setRequired(true)),

  new SlashCommandBuilder()
    .setName("remove").setDescription("[Mod] Remove accounts")
    .addStringOption(o => o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o => o.setName("service").setDescription("Service name").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName("send").setDescription("[Staff] Send accounts via DM")
    .addUserOption(o => o.setName("member").setDescription("Target").setRequired(true))
    .addStringOption(o => o.setName("service").setDescription("Service name").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName("panel").setDescription("[Admin] Configurer le bot pour ce serveur"),

  new SlashCommandBuilder()
    .setName("help").setDescription("List all commands"),
].map(c => c.toJSON());

// ── REGISTER COMMANDS ─────────────────────────────────────────
async function registerCommands() {
  const rest = new REST().setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered globally");
  } catch (e) { console.error("Command registration failed:", e.message); }
}

// ── READY ─────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Bot online: ${client.user.tag}`);
  client.user.setActivity("/help • Gen Bot");
  // Load guild config from GitHub
  await loadGuildConfig();
  await registerCommands();
  // Restore channel→ticket map
  try {
    const res = await fetch(`${BACKEND}/internal/tickets_map`, {
      headers: { "X-Bot-Secret": BOT_SECRET }
    });
    if (res.ok) {
      const map = await res.json();
      for (const [tid, chId] of Object.entries(map)) {
        channelToTicket.set(String(chId), String(tid));
      }
      console.log(`✅ Restored ${Object.keys(map).length} ticket channel mappings`);
    }
  } catch (e) { console.warn("Could not restore ticket map:", e.message); }
});

// ── MESSAGE BRIDGE (Discord → site) ──────────────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  const chId = String(message.channel.id);
  const tid  = channelToTicket.get(chId);
  if (!tid) return;
  await notifyBackend(`/internal/ticket/${tid}/message`, {
    content: message.content,
    author:  message.author.displayName || message.author.username,
  });
});

// ── INTERACTION HANDLER ───────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {

  // Boutons + modals du /panel → handlePanel en priorité
  if (
    (interaction.isButton()      && interaction.customId.startsWith("panel_")) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith("panel_modal_")) ||
    (interaction.isChatInputCommand() && interaction.commandName === "panel")
  ) {
    try {
      await handlePanel(interaction);
    } catch (e) {
      console.error("Panel error:", e);
      try {
        const msg = { content: `❌ Erreur : ${e.message}`, ephemeral: true };
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply(msg);
        } else {
          await interaction.followUp(msg);
        }
      } catch (_) {}
    }
    return;
  }

  // Slash commands seulement en dessous
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try {
    await handleCommand(interaction, commandName);
  } catch (e) {
    console.error(`Command ${commandName} error:`, e);
    const embed = err("Erreur", e.message);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ embeds: [embed], ephemeral: true }).catch(()=>{});
    } else {
      await interaction.reply({ embeds: [embed], ephemeral: true }).catch(()=>{});
    }
  }
});

async function handleCommand(interaction, name) {
  const { guild, member } = interaction;
  const cfg = getCfg(guild?.id);

  // ── /gen ──────────────────────────────────────────
  if (name === "gen") {
    await interaction.deferReply();
    if (!cfg) return interaction.followUp({ embeds: [err("Erreur", "Serveur non configuré.")] });

    const t       = interaction.options.getString("tier");
    const service = capitalize(interaction.options.getString("service"));
    const channels = { free: cfg.freeChannel, premium: cfg.premiumChannel, paid: cfg.paidChannel };

    if (channels[t] && interaction.channelId !== channels[t])
      return interaction.followUp({ embeds: [err("Mauvais salon", `Utilise le bon salon pour le tier **${t}**.`)] });

    if (!isMod(member)) {
      const cd = checkBotCooldown(interaction.user.id, t);
      if (!cd.ok) {
        const m = Math.floor(cd.wait/60), s = cd.wait%60;
        return interaction.followUp({ embeds: [warn("Cooldown", `Attends **${m}m ${s}s** avant de regénérer.`)] });
      }
    }

    const path  = `${ACCOUNTS_DIR}/${t}/${service}.txt`;
    const stock = await readLines(path);
    if (!stock.length)
      return interaction.followUp({ embeds: [err("Out of Stock", `Aucun compte **${service}** en **${t}**.`)] });

    const account = stock.shift();
    await writeLines(path, stock);

    const code    = crypto.randomBytes(3).toString("hex").toUpperCase();
    const pending = await readJson(FILES.pending);
    pending[code] = { account, user: interaction.user.id, tier: t, service };
    await writeJson(FILES.pending, pending);

    const category = guild.channels.cache.get(cfg.ticketCategory);
    if (!category) return interaction.followUp({ embeds: [err("Erreur", "Catégorie tickets introuvable.")] });

    const ticketCh = await guild.channels.create({
      name:   `${service.toLowerCase()}-${interaction.user.username.toLowerCase()}-${Math.floor(Math.random()*9000+1000)}`,
      parent: category,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id: client.user.id,      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id: cfg.staffRole,       allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ],
    });

    const te = new EmbedBuilder()
      .setTitle("🎟️  Generation Ticket")
      .setDescription("Ton compte est réservé ! Un staff va valider ton ticket.")
      .setColor(TIER_COLOR[t])
      .addFields(
        { name: "👤 Membre",    value: interaction.user.toString(), inline: true },
        { name: "📦 Service",   value: `**${service}**`,            inline: true },
        { name: "🏷️ Tier",     value: `${TIER_EMOJI[t]} \`${t.toUpperCase()}\``, inline: true },
        { name: "🔑 Code",      value: `\`\`\`${code}\`\`\``,      inline: false },
        { name: "📋 Commande",  value: `\`/redeem ${code}\``,       inline: false },
      )
      .setFooter({ text: `Stock restant: ${stock.length}` })
      .setTimestamp();

    await ticketCh.send({ content: `<@&${cfg.staffRole}>`, embeds: [te] });

    await interaction.followUp({ embeds: [
      ok("Ticket créé !", `Ton ticket ${ticketCh} est ouvert !\nUn staff va t'aider.`)
        .addFields({ name: "📦 Service", value: `**${service}** (${t.toUpperCase()})`, inline: true })
    ]});

    // Stats
    const stats = await readJson(FILES.stats);
    const uid   = interaction.user.id;
    stats[uid]  = (stats[uid] || 0) + 1;
    const tk    = uid + "_tiers";
    stats[tk]   = stats[tk] || { free:0, premium:0, paid:0 };
    stats[tk][t]++;
    await writeJson(FILES.stats, stats);

    await sendLog(guild, log("📝 Generation", `${interaction.user} a généré **${service}** (${t})`).addFields({ name: "Ticket", value: ticketCh.toString() }));
    return;
  }

  // ── /redeem ───────────────────────────────────────
  if (name === "redeem") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({ embeds: [err("Accès refusé", "No permission.")] });

    const code    = interaction.options.getString("code").toUpperCase();
    const pending = await readJson(FILES.pending);
    if (!pending[code]) return interaction.followUp({ embeds: [err("Code invalide", "Ce code n'existe pas ou a déjà été utilisé.")] });

    const { account, user: userId, webTicketId } = pending[code];
    const target = await guild.members.fetch(userId).catch(() => null);
    if (!target) return interaction.followUp({ embeds: [err("Membre introuvable", "L'utilisateur a quitté le serveur.")] });

    delete pending[code];
    await writeJson(FILES.pending, pending);

    // Register channel → ticket mapping
    if (webTicketId) channelToTicket.set(String(interaction.channelId), String(webTicketId));

    // Notify backend
    if (webTicketId) await notifyBackend(`/internal/ticket/${webTicketId}/redeem`, { account });

    // Give vouch to staff
    const newV = await addVouch(interaction.user.id);
    await checkAndPromote(guild, member, newV);

    await interaction.followUp({ embeds: [ok("Envoyé !", `Le compte a été transmis à **${target.user.username}** via ${webTicketId ? "le ticket web" : "DM"}.`)] });

    // For Discord-only tickets: send DM
    if (!webTicketId) {
      const dmEmbed = new EmbedBuilder()
        .setTitle("📦  Ton compte est prêt !")
        .setDescription("Ne le partage avec personne !")
        .setColor(C.success)
        .addFields({ name: "🔐 Identifiants", value: `\`\`\`${account}\`\`\`` })
        .setTimestamp();
      await target.send({ embeds: [dmEmbed] }).catch(() => {});
    }

    const l = log("📝 Redeem", `${interaction.user} a validé un ticket pour ${target.user}`)
      .addFields(
        { name: "Account",       value: `||${account}||`, inline: true },
        { name: "Staff Vouches", value: `**${newV}**`,    inline: true },
      );
    if (webTicketId) l.addFields({ name: "Source", value: "🌐 Web", inline: true });
    await sendLog(guild, l);

    if (!webTicketId) {
      await new Promise(r => setTimeout(r, 5000));
      await interaction.channel.delete().catch(console.error);
    } else {
      await interaction.channel.send({ embeds: [
        new EmbedBuilder()
          .setTitle("✅ Compte validé")
          .setDescription(`Transmis à **${interaction.user.displayName}** via le ticket web.`)
          .setColor(0x57F287)
      ]});
    }
    return;
  }

  // ── /close ────────────────────────────────────────
  if (name === "close") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({ embeds: [err("Accès refusé", "No permission.")] });

    const chId     = String(interaction.channelId);
    const ticketId = channelToTicket.get(chId);
    if (ticketId) {
      channelToTicket.delete(chId);
      await notifyBackend(`/internal/ticket/${ticketId}/close`);
    }

    await interaction.followUp({ embeds: [log("🔒 Ticket fermé", `Fermé par ${interaction.user}`).setColor(C.error)] });
    await new Promise(r => setTimeout(r, 5000));
    await interaction.channel.delete().catch(console.error);
    return;
  }

  // ── /addv ─────────────────────────────────────────
  if (name === "addv") {
    await interaction.deferReply();
    if (!hasAddv(member)) return interaction.followUp({ embeds: [err("Accès refusé", "No permission.")] });
    const target = interaction.options.getMember("member");
    const amount = interaction.options.getInteger("amount");
    const newV   = await addVouch(target.id, amount);
    await checkAndPromote(guild, target, newV);
    await interaction.followUp({ embeds: [ok("Vouches ajoutés !", `+**${amount}** pour ${target}. Total : **${newV}**.`)] });
    await sendLog(guild, log("📝 Vouches", `${interaction.user} +${amount} → ${target.user}`).addFields({ name: "Total", value: `**${newV}**`, inline: true }));
    return;
  }

  // ── /promote ──────────────────────────────────────
  if (name === "promote") {
    await interaction.deferReply();
    const target  = interaction.options.getMember("member") || member;
    const vouches = await getVouches(target.id);
    const cfg2    = getCfg(guild.id);
    const embed   = new EmbedBuilder()
      .setTitle("🏅  Vouch Progress")
      .setDescription(`Stats pour ${target}`)
      .setColor(C.info)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields({ name: "⭐ Total Vouches", value: `**${vouches}**`, inline: true });

    const next = cfg2?.vouchTiers.find(vt => vouches < vt.threshold);
    if (next) {
      const filled = Math.round(Math.min(vouches / next.threshold, 1) * 10);
      const bar    = "█".repeat(filled) + "░".repeat(10-filled);
      embed.addFields(
        { name: "🎯 Prochain palier", value: `**${next.threshold}** → ${next.roles.map(r=>`<@&${r}>`).join(" ")}`, inline: true },
        { name: "📊 Progression",     value: `\`${bar}\` ${vouches}/${next.threshold} (**${next.threshold-vouches}** restants)`, inline: false },
      );
    } else {
      embed.addFields({ name: "🏆", value: "Rang maximum atteint !", inline: false });
    }

    if (cfg2) {
      const milestones = cfg2.vouchTiers.map(vt =>
        `${vouches >= vt.threshold ? "✅" : "🔒"} **${vt.threshold} vouches** → ${vt.roles.map(r=>`<@&${r}>`).join(" ")}`
      );
      embed.addFields({ name: "📋 Paliers", value: milestones.join("\n"), inline: false });
    }

    embed.setFooter({ text: "Vouches gagnés en validant des tickets • Ne reset jamais" }).setTimestamp();
    await interaction.followUp({ embeds: [embed] });
    return;
  }

  // ── /stock ────────────────────────────────────────
  if (name === "stock") {
    await interaction.deferReply();
    const tierFilter = interaction.options.getString("tier");
    const tiers = tierFilter ? [tierFilter] : ["free","premium","paid"];
    const colorMap = { free:C.free, premium:C.premium, paid:C.paid };
    const embed = new EmbedBuilder()
      .setTitle(`📦  Stock — ${tierFilter || "All"}`)
      .setColor(tierFilter ? colorMap[tierFilter] : C.info)
      .setTimestamp();
    let total = 0;
    for (const t of tiers) {
      const files = await listDir(`${ACCOUNTS_DIR}/${t}`);
      const lines = [];
      for (const f of files) {
        if (!f.name.endsWith(".txt")) continue;
        const count = (await readLines(f.path)).length;
        total += count;
        const bar = "█".repeat(Math.min(Math.floor(count/10),10)) + "░".repeat(Math.max(0,10-Math.min(Math.floor(count/10),10)));
        lines.push(`\`${bar}\` **${f.name.replace(".txt","")}** — ${count}`);
      }
      embed.addFields({ name: `${TIER_EMOJI[t]}  ${t.toUpperCase()}`, value: lines.join("\n") || "*Aucun stock*", inline: false });
    }
    embed.setFooter({ text: `Total : ${total} comptes` });
    await interaction.followUp({ embeds: [embed] });
    return;
  }

  // ── /profile ──────────────────────────────────────
  if (name === "profile") {
    await interaction.deferReply();
    const target  = interaction.options.getMember("member") || member;
    const uid     = target.id;
    const stats   = await readJson(FILES.stats);
    const total   = typeof stats[uid] === "number" ? stats[uid] : 0;
    const td      = stats[uid + "_tiers"] || { free:0, premium:0, paid:0 };
    const vouches = await getVouches(uid);
    const now     = Date.now();

    const bar = (uses, max) => {
      const filled = Math.round((uses/max)*5);
      return "🟩".repeat(filled) + "⬛".repeat(5-filled) + `  \`${uses}/${max}\``;
    };

    // Check remaining cooldowns from botCooldowns
    const getUses = (t) => {
      const key    = `${uid}:${t}`;
      const limits = { free:3600, premium:3600, paid:3600 };
      return (botCooldowns.get(key) || []).filter(ts => now - ts < limits[t]*1000).length;
    };

    const embed = new EmbedBuilder()
      .setTitle("👤  Profile")
      .setDescription(`Stats pour ${target}`)
      .setColor(C.info)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: "🎯 Total Gens", value: `**${total}**`,   inline: true },
        { name: "⭐ Vouches",    value: `**${vouches}**`, inline: true },
        { name: "\u200b",        value: "\u200b",          inline: true },
        { name: "🟢 Free",       value: `**${td.free||0}**`,    inline: true },
        { name: "🟣 Premium",    value: `**${td.premium||0}**`, inline: true },
        { name: "🟡 Paid",       value: `**${td.paid||0}**`,    inline: true },
        { name: "🟢 Quota Free",    value: bar(getUses("free"),1),    inline: true },
        { name: "🟣 Quota Premium", value: bar(getUses("premium"),3), inline: true },
        { name: "🟡 Quota Paid",    value: bar(getUses("paid"),10),   inline: true },
      )
      .setFooter({ text: "Quota reset toutes les heures • Vouches ne reset jamais" })
      .setTimestamp();
    await interaction.followUp({ embeds: [embed] });
    return;
  }

  // ── /leaderboard ──────────────────────────────────
  if (name === "leaderboard") {
    await interaction.deferReply();
    const stats = await readJson(FILES.stats);
    const top = Object.entries(stats)
      .filter(([k,v]) => /^\d+$/.test(k) && typeof v === "number")
      .sort(([,a],[,b]) => b-a)
      .slice(0, 10);

    const medals = ["🥇","🥈","🥉"];
    const embed  = new EmbedBuilder().setTitle("🏆  Leaderboard — Top Generators").setColor(C.paid).setTimestamp();
    if (!top.length) {
      embed.setDescription("*Aucune génération encore.*");
    } else {
      const lines = await Promise.all(top.map(async ([uid, count], i) => {
        const m = await guild.members.fetch(uid).catch(() => null);
        const name = m?.displayName || `User #${uid}`;
        return `${medals[i] || `\`#${i+1}\``}  **${name}** — ${count} gen${count>1?"s":""}`;
      }));
      embed.setDescription(lines.join("\n"));
    }
    embed.setFooter({ text: `Demandé par ${interaction.user.displayName}` });
    await interaction.followUp({ embeds: [embed] });
    return;
  }

  // ── /add ──────────────────────────────────────────
  if (name === "add") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({ embeds: [err("Accès refusé", "No permission.")] });
    const t       = interaction.options.getString("tier");
    const service = capitalize(interaction.options.getString("service"));
    const file    = interaction.options.getAttachment("file");
    if (!file.name.endsWith(".txt")) return interaction.followUp({ embeds: [err("Fichier invalide", "Seulement des fichiers .txt.")] });

    const res   = await fetch(file.url);
    const text  = await res.text();
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const path  = `${ACCOUNTS_DIR}/${t}/${service}.txt`;
    const stock = await readLines(path);
    stock.push(...lines);
    await writeLines(path, stock);

    await interaction.followUp({ embeds: [ok("Stock mis à jour !", `**${lines.length}** comptes ajoutés → \`${t}/${service}\`. Total : **${stock.length}**.`)] });
    await sendLog(guild, log("📝 Stock Added", `${interaction.user} +${lines.length} → \`${t}/${service}\``));
    return;
  }

  // ── /remove ───────────────────────────────────────
  if (name === "remove") {
    await interaction.deferReply();
    if (!isMod(member)) return interaction.followUp({ embeds: [err("Accès refusé", "No permission.")] });
    const t       = interaction.options.getString("tier");
    const service = capitalize(interaction.options.getString("service"));
    const amount  = interaction.options.getInteger("amount");
    const path    = `${ACCOUNTS_DIR}/${t}/${service}.txt`;
    const stock   = await readLines(path);
    if (stock.length < amount) return interaction.followUp({ embeds: [warn("Stock insuffisant", `Seulement **${stock.length}** disponibles.`)] });
    stock.splice(0, amount);
    await writeLines(path, stock);
    await interaction.followUp({ embeds: [ok("Retiré !", `**${amount}** comptes retirés. Restant : **${stock.length}**.`)] });
    await sendLog(guild, log("📝 Stock Removed", `${interaction.user} -${amount} → \`${t}/${service}\``));
    return;
  }

  // ── /send ─────────────────────────────────────────
  if (name === "send") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({ embeds: [err("Accès refusé", "No permission.")] });
    const target  = interaction.options.getMember("member");
    const service = capitalize(interaction.options.getString("service"));
    const amount  = interaction.options.getInteger("amount");

    // Helper cooldown check
    if (!isMod(member)) {
      const cdData = await readJson(FILES.sendCd);
      const now    = Date.now();
      const key    = interaction.user.id;
      const uses   = (cdData[key] || []).filter(ts => now - ts < 3600000);
      if (uses.length >= 5) return interaction.followUp({ embeds: [warn("Limite", "Max 5 envois par heure.")] });
      uses.push(now); cdData[key] = uses;
      await writeJson(FILES.sendCd, cdData);
    }

    let sent = false;
    for (const t of ["free","premium","paid"]) {
      const path  = `${ACCOUNTS_DIR}/${t}/${service}.txt`;
      const stock = await readLines(path);
      if (stock.length >= amount) {
        const accs = stock.splice(0, amount);
        await writeLines(path, stock);
        // DM in chunks of 10
        for (let i = 0; i < accs.length; i += 10) {
          const chunk = accs.slice(i, i+10);
          await target.send({ embeds: [
            new EmbedBuilder()
              .setTitle(`📦 ${service} (${t.toUpperCase()})`)
              .setDescription("```\n" + chunk.join("\n") + "\n```")
              .setColor(TIER_COLOR[t])
              .setFooter({ text: `Envoyé par ${interaction.user.displayName} • Gen Bot` })
              .setTimestamp()
          ]}).catch(() => {});
        }
        sent = true;
        await interaction.followUp({ embeds: [ok("Envoyé !", `**${amount}** **${service}** envoyés à ${target}.`)] });
        await sendLog(guild, log("📝 Direct Send", `${interaction.user} → ${target.user} x${amount} \`${service}\``));
        break;
      }
    }
    if (!sent) await interaction.followUp({ embeds: [err("Pas de stock", `Pas assez de comptes **${service}**.`)] });
    return;
  }

  // ── /help ─────────────────────────────────────────
  if (name === "help") {
    const embed = new EmbedBuilder()
      .setTitle("📜  Commands — Gen Bot")
      .setDescription("Toutes les commandes utilisent `/`")
      .setColor(C.info)
      .addFields(
        { name: "👥  Membres",  value: "`/gen` `/profile` `/promote` `/leaderboard` `/stock`",    inline: false },
        { name: "🛡️  Staff",   value: "`/redeem` `/close` `/add` `/send` `/remove` `/addv`",      inline: false },
        { name: "🏷️  Tiers",   value: "🟢 `free` · 🟣 `premium` · 🟡 `paid`",                   inline: false },
      )
      .setFooter({ text: "Gen Bot • Besoin d'aide ? Contacte un staff." })
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return;
  }
}

export function startBot() {
  client.login(process.env.TOKEN).catch(e => {
    console.error("Bot login failed:", e.message);
  });
}
