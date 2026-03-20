import {
  Client, GatewayIntentBits, Partials, Events,
  SlashCommandBuilder, EmbedBuilder, PermissionsBitField,
  REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { readJson, writeJson, readLines, writeLines, listDir } from "./github.js";
import { GUILDS, FILES, ACCOUNTS_DIR, BOT_SECRET, TIERS, TIER_META,
         COOLDOWN_LIMITS, loadGuildConfig, getGuild } from "./config.js";
import { channelToTicket } from "./server.js";
import crypto from "crypto";
import http from "http";

const BACKEND = process.env.BACKEND_URL || "https://pejxjcykzlqjsloshvhbb-production.up.railway.app";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
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
              .setTitle("🏆  Félicitations !")
              .setDescription(`${member} a atteint **${threshold} vouches** !

> ${message}`)
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
        const l=log("🎉  Promotion",`${member} → ${newly.map(r=>`<@&${r}>`).join(" ")} avec **${vouches} vouches**!`);
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
      await channel.send({ embeds:[err("Giveaway terminé","Aucune participation — pas de gagnant.")] });
      return;
    }
    const users = await reaction.users.fetch();
    const eligible = users.filter(u => !u.bot);
    if (!eligible.size) {
      await channel.send({ embeds:[err("Giveaway terminé","Aucune participation valide.")] });
      return;
    }

    const winner = eligible.random();
    const meta   = TIER_META[gw.tier] || TIER_META.free;

    // Send account to winner via DM
    const dmEmbed = new EmbedBuilder()
      .setTitle("🎉  Tu as gagné un giveaway !")
      .setDescription(`Félicitations ! Voici ton compte **${gw.service}** :`)
      .setColor(meta.color)
      .addFields({ name:"🔐 Compte", value:`\`\`\`${gw.account}\`\`\`` })
      .setFooter({ text:"Gen Bot • Ne partage pas ce compte !" })
      .setTimestamp();

    await winner.send({ embeds:[dmEmbed] }).catch(async () => {
      await channel.send(`${winner} — tes DMs sont fermés, contacte un staff pour recevoir ton compte.`);
    });

    // Announce winner
    const winEmbed = new EmbedBuilder()
      .setTitle("🎉  Giveaway terminé !")
      .setColor(meta.color)
      .addFields(
        { name:"🏆 Gagnant",  value:winner.toString(),     inline:true },
        { name:"📦 Service",  value:`**${gw.service}**`,   inline:true },
        { name:"🏷️ Tier",    value:`${meta.emoji} **${meta.label}**`, inline:true },
      )
      .setDescription("Le compte a été envoyé en DM au gagnant !")
      .setTimestamp();

    await channel.send({ content:`🎉 Félicitations ${winner} !`, embeds:[winEmbed] });

    // Update original message
    await message.edit({ embeds:[
      new EmbedBuilder()
        .setTitle("🎁  Giveaway — TERMINÉ")
        .setColor(0x2B2D31)
        .addFields(
          { name:"📦 Service",  value:`**${gw.service}**`,           inline:true },
          { name:"🏷️ Tier",    value:`${meta.emoji} ${meta.label}`, inline:true },
          { name:"🏆 Gagnant", value:winner.toString(),              inline:true },
        )
        .setFooter({ text:"Giveaway terminé" })
        .setTimestamp()
    ]}).catch(()=>{});

    // Log
    const cfg = getCfg(gw.guildId);
    if (cfg) {
      const l = log("🎁 Giveaway terminé",`Gagnant : ${winner} • **${gw.service}** (${gw.tier})`);
      l.setColor(meta.color);
      await sendLog(guild, l);
    }
  } catch(e) { console.error("endGiveaway error:", e); }
}

// ── SLASH COMMANDS ────────────────────────────────────────────
const TIER_CHOICES = TIERS.map(t => ({ name:`${TIER_META[t].emoji} ${TIER_META[t].label}`, value:t }));

const commands = [
  new SlashCommandBuilder().setName("gen").setDescription("Générer un compte")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service (ex: Netflix)").setRequired(true)),

  new SlashCommandBuilder().setName("redeem").setDescription("[Staff] Valider un ticket")
    .addStringOption(o=>o.setName("code").setDescription("Code du ticket").setRequired(true)),

  new SlashCommandBuilder().setName("close").setDescription("[Staff] Fermer un ticket"),

  new SlashCommandBuilder().setName("giveaway").setDescription("[Staff] Lancer un giveaway")
    .addStringOption(o=>o.setName("service").setDescription("Service (ex: Netflix)").setRequired(true))
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addIntegerOption(o=>o.setName("duree").setDescription("Durée en minutes").setRequired(true).setMinValue(1).setMaxValue(10080)),

  new SlashCommandBuilder().setName("addv").setDescription("[Admin] Ajouter des vouches")
    .addUserOption(o=>o.setName("member").setDescription("Cible").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Nombre").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("promote").setDescription("Voir la progression des vouches")
    .addUserOption(o=>o.setName("member").setDescription("Cible (vide = toi)")),

  new SlashCommandBuilder().setName("stock").setDescription("Voir le stock disponible")
    .addStringOption(o=>o.setName("tier").setDescription("Filtrer par tier").addChoices(...TIER_CHOICES)),

  new SlashCommandBuilder().setName("profile").setDescription("Voir un profil")
    .addUserOption(o=>o.setName("member").setDescription("Cible (vide = toi)")),

  new SlashCommandBuilder().setName("leaderboard").setDescription("Top 10 générateurs"),

  new SlashCommandBuilder().setName("add").setDescription("[Staff] Ajouter du stock")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addAttachmentOption(o=>o.setName("file").setDescription("Fichier .txt").setRequired(true)),

  new SlashCommandBuilder().setName("remove").setDescription("[Mod] Retirer du stock")
    .addStringOption(o=>o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIER_CHOICES))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Nombre").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("send").setDescription("[Staff] Envoyer des comptes en DM")
    .addUserOption(o=>o.setName("member").setDescription("Cible").setRequired(true))
    .addStringOption(o=>o.setName("service").setDescription("Service").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Nombre").setRequired(true).setMinValue(1)),

new SlashCommandBuilder().setName("help").setDescription("Liste des commandes"),
].map(c=>c.toJSON());

async function registerCommands() {
  const rest = new REST().setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body:commands });
    console.log("✅ Slash commands registered");
  } catch(e) { console.error("Command registration failed:", e.message); }
}

// ── READY ─────────────────────────────────────────────────────
let botReady = false;
client.once(Events.ClientReady, async () => {
  botReady = true;
  console.log(`🤖 Bot online: ${client.user.tag}`);
  client.user.setActivity("/help • Gen Bot");
  await loadGuildConfig();
  await registerCommands();
  await loadGiveaways();
  try {
    const res = await fetch(`${BACKEND}/internal/tickets_map`,{headers:{"X-Bot-Secret":BOT_SECRET}});
    if (res.ok) {
      const map = await res.json();
      for (const [tid,chId] of Object.entries(map)) channelToTicket.set(String(chId),String(tid));
      console.log(`✅ Restored ${Object.keys(map).length} ticket mappings`);
    }
  } catch(e) { console.warn("Could not restore ticket map:", e.message); }
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
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try { await handleCommand(interaction, commandName); }
  catch(e) {
    console.error(`/${commandName} error:`, e);
    const embed = err("Erreur", e.message);
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

  // ── /gen ──────────────────────────────────────────
  if (name === "gen") {
    await interaction.deferReply();
    if (!cfg) return interaction.followUp({embeds:[err("Erreur","Serveur non configuré.")]});

    const t       = interaction.options.getString("tier");
    const service = capitalize(interaction.options.getString("service"));
    const meta    = TIER_META[t];

    const chKey   = `${t}Channel`;
    const chId    = cfg[chKey];
    if (chId && interaction.channelId !== chId)
      return interaction.followUp({embeds:[err("Mauvais salon",`Utilise <#${chId}> pour le tier **${meta.label}**.`)]});

    if (!isMod(member)) {
      const cd = checkBotCooldown(interaction.user.id, t);
      if (!cd.ok) {
        const m=Math.floor(cd.wait/60), s=cd.wait%60;
        return interaction.followUp({embeds:[warn("Cooldown",`Attends **${m}m ${s}s** avant de regénérer.`)]});
      }
    }

    const path  = `${ACCOUNTS_DIR}/${t}/${service}.txt`;
    const stock = await readLines(path);
    if (!stock.length) return interaction.followUp({embeds:[err("Out of Stock",`Aucun compte **${service}** en **${meta.label}**.`)]});

    const account = stock.shift(); await writeLines(path, stock);
    const code    = crypto.randomBytes(3).toString("hex").toUpperCase();
    const pending = await readJson(FILES.pending);
    pending[code] = { account, user:interaction.user.id, tier:t, service };
    await writeJson(FILES.pending, pending);

    const category = guild.channels.cache.get(cfg.ticketCategory);
    if (!category) return interaction.followUp({embeds:[err("Erreur","Catégorie tickets introuvable.")]});

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
      .setTitle("🎟️  Ticket de génération")
      .setColor(meta.color)
      .addFields(
        { name:"👤 Membre",   value:interaction.user.toString(), inline:true },
        { name:"📦 Service",  value:`**${service}**`,            inline:true },
        { name:"🏷️ Tier",    value:`${meta.emoji} **${meta.label}**`, inline:true },
        { name:"🔑 Code",     value:`\`\`\`${code}\`\`\``,       inline:false },
        { name:"📋 Commande", value:`\`/redeem ${code}\``,        inline:false },
      )
      .setFooter({ text:`Stock restant : ${stock.length}` }).setTimestamp();

    await ticketCh.send({ content:`<@&${cfg.staffRole}>`, embeds:[te] });
    await interaction.followUp({ embeds:[
      ok("Ticket créé !",`Ton ticket ${ticketCh} est ouvert !\nUn staff va t'aider sous peu.`)
        .addFields({ name:"📦 Service", value:`**${service}** (${meta.label})`, inline:true })
    ]});

    const stats = await readJson(FILES.stats);
    const uid   = interaction.user.id;
    stats[uid]  = (stats[uid]||0)+1;
    const tk    = uid+"_tiers"; stats[tk]=stats[tk]||{};
    stats[tk][t]=(stats[tk][t]||0)+1;
    await writeJson(FILES.stats, stats);
    await sendLog(guild, log("📝 Generation",`${interaction.user} a généré **${service}** (${meta.label})`).addFields({name:"Ticket",value:ticketCh.toString()}));
    return;
  }

  // ── /redeem ───────────────────────────────────────
  if (name === "redeem") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Accès refusé","No permission.")]});

    const code    = interaction.options.getString("code").toUpperCase();
    const pending = await readJson(FILES.pending);
    if (!pending[code]) return interaction.followUp({embeds:[err("Code invalide","Ce code n'existe pas ou a déjà été utilisé.")]});

    const { account, user:userId, webTicketId, tier:t, service } = pending[code];
    const target = await guild.members.fetch(userId).catch(()=>null);
    if (!target) return interaction.followUp({embeds:[err("Membre introuvable","L'utilisateur a quitté le serveur.")]});

    delete pending[code]; await writeJson(FILES.pending, pending);

    if (webTicketId) channelToTicket.set(String(interaction.channelId), String(webTicketId));
    if (webTicketId) await notifyBackend(`/internal/ticket/${webTicketId}/redeem`,{account});

    if (!webTicketId) {
      const meta   = TIER_META[t]||TIER_META.free;
      const dmEmbed = new EmbedBuilder()
        .setTitle("📦  Ton compte est prêt !")
        .setDescription("Ne le partage avec personne !")
        .setColor(meta.color)
        .addFields({ name:"🔐 Identifiants", value:`\`\`\`${account}\`\`\`` })
        .setTimestamp();
      await target.send({embeds:[dmEmbed]}).catch(()=>{});
    }

    const newV = await addVouch(interaction.user.id);
    await checkAndPromote(guild, member, newV);

    await interaction.followUp({embeds:[ok("Validé !",`Compte transmis à **${target.user.username}** via ${webTicketId?"le ticket web":"DM"}.`)]});

    const l = log("📝 Redeem",`${interaction.user} a validé pour ${target.user}`)
      .addFields({name:"Account",value:`||${account}||`,inline:true},{name:"Vouches",value:`**${newV}**`,inline:true});
    if (webTicketId) l.addFields({name:"Source",value:"🌐 Web",inline:true});
    await sendLog(guild, l);

    if (!webTicketId) {
      await new Promise(r=>setTimeout(r,5000));
      await interaction.channel.delete().catch(console.error);
    } else {
      await interaction.channel.send({embeds:[
        new EmbedBuilder().setTitle("✅ Compte validé").setDescription(`Transmis via le ticket web.`).setColor(C.success)
      ]});
    }
    return;
  }

  // ── /close ────────────────────────────────────────
  if (name === "close") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Accès refusé","No permission.")]});
    const chId = String(interaction.channelId);
    const tid  = channelToTicket.get(chId);
    if (tid) { channelToTicket.delete(chId); await notifyBackend(`/internal/ticket/${tid}/close`); }
    await interaction.followUp({embeds:[log("🔒 Ticket fermé",`Fermé par ${interaction.user}`).setColor(C.error)]});
    await new Promise(r=>setTimeout(r,5000));
    await interaction.channel.delete().catch(console.error);
    return;
  }

  // ── /giveaway ─────────────────────────────────────
  if (name === "giveaway") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Accès refusé","No permission.")]});

    const service = capitalize(interaction.options.getString("service"));
    const t       = interaction.options.getString("tier");
    const duree   = interaction.options.getInteger("duree");
    const meta    = TIER_META[t];

    // Check stock
    const path  = `${ACCOUNTS_DIR}/${t}/${service}.txt`;
    const stock = await readLines(path);
    if (!stock.length) return interaction.followUp({embeds:[err("Out of Stock",`Aucun compte **${service}** en **${meta.label}**.`)]});

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
        { name:"🎫 Participer",value:"Réagis avec 🎉 pour participer !",    inline:false },
      )
      .setFooter({ text:`Organisé par ${interaction.user.displayName}` })
      .setTimestamp();

    const gwMsg = await interaction.channel.send({ embeds:[gwEmbed] });
    await gwMsg.react("🎉");
    await interaction.followUp({ content:"✅ Giveaway lancé !", ephemeral:true });

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

    await sendLog(guild, log("🎁 Giveaway lancé",`${interaction.user} a lancé un giveaway **${service}** (${meta.label}) — durée : ${duree}min`));
    return;
  }

  // ── /addv ─────────────────────────────────────────
  if (name === "addv") {
    await interaction.deferReply();
    if (!hasAddv(member)) return interaction.followUp({embeds:[err("Accès refusé","No permission.")]});
    const target = interaction.options.getMember("member");
    const amount = interaction.options.getInteger("amount");
    const newV   = await addVouch(target.id, amount);
    await checkAndPromote(guild, target, newV);
    await interaction.followUp({embeds:[ok("Vouches ajoutés !",`+**${amount}** pour ${target}. Total : **${newV}**.`)]});
    await sendLog(guild, log("📝 Vouches",`${interaction.user} +${amount} → ${target.user}`).addFields({name:"Total",value:`**${newV}**`,inline:true}));
    return;
  }

  // ── /promote ──────────────────────────────────────
  if (name === "promote") {
    await interaction.deferReply();
    const target  = interaction.options.getMember("member")||member;
    const vouches = await getVouches(target.id);
    const cfg2    = getCfg(guild.id);
    const embed   = new EmbedBuilder().setTitle("🏅  Progression des vouches")
      .setDescription(`Stats pour ${target}`).setColor(C.info).setThumbnail(target.user.displayAvatarURL())
      .addFields({name:"⭐ Total",value:`**${vouches}**`,inline:true});
    const next = cfg2?.vouchTiers.find(vt=>vouches<vt.threshold);
    if (next) {
      const filled=Math.round(Math.min(vouches/next.threshold,1)*10);
      embed.addFields(
        {name:"🎯 Prochain",value:`**${next.threshold}** → ${next.roles.map(r=>`<@&${r}>`).join(" ")}`,inline:true},
        {name:"📊 Progression",value:`\`${"█".repeat(filled)}${"░".repeat(10-filled)}\` ${vouches}/${next.threshold}`,inline:false},
      );
    } else embed.addFields({name:"🏆",value:"Rang maximum atteint !",inline:false});
    if (cfg2) {
      embed.addFields({name:"📋 Paliers",value:cfg2.vouchTiers.map(vt=>`${vouches>=vt.threshold?"✅":"🔒"} **${vt.threshold}** → ${vt.roles.map(r=>`<@&${r}>`).join(" ")}`).join("\n"),inline:false});
    }
    embed.setFooter({text:"Vouches gagnés en validant des tickets"}).setTimestamp();
    await interaction.followUp({embeds:[embed]});
    return;
  }

  // ── /stock ────────────────────────────────────────
  if (name === "stock") {
    await interaction.deferReply();
    const tf = interaction.options.getString("tier");
    const tiers = tf ? [tf] : TIERS;
    const embed = new EmbedBuilder().setTitle(`📦  Stock${tf?` — ${TIER_META[tf].label}`:""}`).setColor(tf?TIER_META[tf].color:C.info).setTimestamp();
    let total=0;
    for (const t of tiers) {
      const files=await listDir(`${ACCOUNTS_DIR}/${t}`); const lines=[];
      for (const f of files) { if (!f.name.endsWith(".txt")) continue; const count=(await readLines(f.path)).length; total+=count; const bar="█".repeat(Math.min(Math.floor(count/10),10))+"░".repeat(Math.max(0,10-Math.min(Math.floor(count/10),10))); lines.push(`\`${bar}\` **${f.name.replace(".txt","")}** — ${count}`); }
      embed.addFields({name:`${TIER_META[t].emoji} ${TIER_META[t].label}`,value:lines.join("\n")||"*Vide*",inline:false});
    }
    embed.setFooter({text:`Total : ${total} comptes`});
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
    const embed=new EmbedBuilder().setTitle("👤  Profil").setDescription(`Stats pour ${target}`).setColor(C.info).setThumbnail(target.user.displayAvatarURL())
      .addFields(
        {name:"🎯 Total Gens",value:`**${total}**`,inline:true},
        {name:"⭐ Vouches",   value:`**${vouches}**`,inline:true},
        {name:"\u200b",       value:"\u200b",inline:true},
        ...TIERS.map(t=>({name:`${TIER_META[t].emoji} ${TIER_META[t].label}`,value:`**${td[t]||0}**`,inline:true})),
        {name:"\u200b",value:"\u200b",inline:false},
        ...TIERS.map(t=>({name:`Quota ${TIER_META[t].label}`,value:bar(getUses(t),COOLDOWN_LIMITS[t].max),inline:true})),
      )
      .setFooter({text:"Quota reset/h • Vouches jamais reset"}).setTimestamp();
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
    if (!top.length) embed.setDescription("*Aucune génération encore.*");
    else {
      const lines=await Promise.all(top.map(async([uid,count],i)=>{
        const m=await guild.members.fetch(uid).catch(()=>null);
        return `${medals[i]||`\`#${i+1}\``}  **${m?.displayName||`User #${uid}`}** — ${count} gen${count>1?"s":""}`;
      }));
      embed.setDescription(lines.join("\n"));
    }
    embed.setFooter({text:`Demandé par ${interaction.user.displayName}`});
    await interaction.followUp({embeds:[embed]});
    return;
  }

  // ── /add ──────────────────────────────────────────
  if (name === "add") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Accès refusé","No permission.")]});
    const t=interaction.options.getString("tier"), service=capitalize(interaction.options.getString("service")), file=interaction.options.getAttachment("file");
    if (!file.name.endsWith(".txt")) return interaction.followUp({embeds:[err("Fichier invalide","Seulement .txt")]});
    const res=await fetch(file.url); const text=await res.text();
    const lines=text.split("\n").map(l=>l.trim()).filter(Boolean);
    const path=`${ACCOUNTS_DIR}/${t}/${service}.txt`; const stock=await readLines(path); stock.push(...lines); await writeLines(path,stock);
    await interaction.followUp({embeds:[ok("Stock mis à jour !",`**${lines.length}** comptes ajoutés → \`${t}/${service}\`. Total : **${stock.length}**.`)]});
    await sendLog(guild, log("📝 Stock Added",`${interaction.user} +${lines.length} → \`${t}/${service}\``));
    return;
  }

  // ── /remove ───────────────────────────────────────
  if (name === "remove") {
    await interaction.deferReply();
    if (!isMod(member)) return interaction.followUp({embeds:[err("Accès refusé","No permission.")]});
    const t=interaction.options.getString("tier"), service=capitalize(interaction.options.getString("service")), amount=interaction.options.getInteger("amount");
    const path=`${ACCOUNTS_DIR}/${t}/${service}.txt`; const stock=await readLines(path);
    if (stock.length<amount) return interaction.followUp({embeds:[warn("Stock insuffisant",`Seulement **${stock.length}** disponibles.`)]});
    stock.splice(0,amount); await writeLines(path,stock);
    await interaction.followUp({embeds:[ok("Retiré !",`**${amount}** retirés. Restant : **${stock.length}**.`)]});
    await sendLog(guild, log("📝 Stock Removed",`${interaction.user} -${amount} → \`${t}/${service}\``));
    return;
  }

  // ── /send ─────────────────────────────────────────
  if (name === "send") {
    await interaction.deferReply();
    if (!isStaff(member)) return interaction.followUp({embeds:[err("Accès refusé","No permission.")]});
    const target=interaction.options.getMember("member"), service=capitalize(interaction.options.getString("service")), amount=interaction.options.getInteger("amount");
    if (!isMod(member)) {
      const cdD=await readJson(FILES.sendCd); const now=Date.now(); const key=interaction.user.id;
      const uses=(cdD[key]||[]).filter(ts=>now-ts<3600000);
      if (uses.length>=5) return interaction.followUp({embeds:[warn("Limite","Max 5 envois/heure.")]});
      uses.push(now); cdD[key]=uses; await writeJson(FILES.sendCd,cdD);
    }
    let sent=false;
    for (const t of TIERS) {
      const path=`${ACCOUNTS_DIR}/${t}/${service}.txt`; const stock=await readLines(path);
      if (stock.length>=amount) {
        const accs=stock.splice(0,amount); await writeLines(path,stock);
        for (let i=0;i<accs.length;i+=10) {
          await target.send({embeds:[new EmbedBuilder().setTitle(`📦 ${service} (${TIER_META[t].label})`).setDescription("```\n"+accs.slice(i,i+10).join("\n")+"\n```").setColor(TIER_META[t].color).setTimestamp()]}).catch(()=>{});
        }
        sent=true; await interaction.followUp({embeds:[ok("Envoyé !",`**${amount}** **${service}** envoyés à ${target}.`)]}); break;
      }
    }
    if (!sent) await interaction.followUp({embeds:[err("Pas de stock",`Pas assez de **${service}**.`)]});
    else await sendLog(guild, log("📝 Direct Send",`${interaction.user} → ${target.user} x${amount} \`${service}\``));
    return;
  }

  // ── /help ─────────────────────────────────────────
  if (name === "help") {
    const embed=new EmbedBuilder().setTitle("📜  Commands — Gen Bot").setColor(C.info)
      .addFields(
        {name:"👥  Membres",  value:"`/gen` `/profile` `/promote` `/leaderboard` `/stock`",inline:false},
        {name:"🛡️  Staff",   value:"`/redeem` `/close` `/giveaway` `/add` `/send` `/remove` `/addv`",inline:false},
        {name:"🏷️  Tiers",   value:TIERS.map(t=>`${TIER_META[t].emoji} \`${t}\``).join(" · "),inline:false},
      ).setFooter({text:"Gen Bot"}).setTimestamp();
    await interaction.reply({embeds:[embed]});
    return;
  }
}

// ── MINI SERVEUR HTTP INTERNE (pour le bridge server→bot) ────

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

      // Attendre que le bot soit prêt (max 15s)
      let waited = 0;
      while (!botReady && waited < 15000) {
        await new Promise(r => setTimeout(r, 300));
        waited += 300;
      }

      // Forcer le fetch si pas en cache
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

      // Construire les overwrites — uniquement avec des IDs valides
      const VIEW_SEND = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages];
      const NO_VIEW   = [PermissionsBitField.Flags.ViewChannel];
      console.log(`[bot-bridge] staffRole=${cfg.staffRole} botId=${client.user.id} guildId=${guild.id}`);

      const permOverwrites = [
        { id: guild.id, deny: NO_VIEW },
      ];
      if (client.user?.id) permOverwrites.push({ id: client.user.id, allow: VIEW_SEND });
      if (cfg.staffRole)   permOverwrites.push({ id: cfg.staffRole,  allow: VIEW_SEND });

      const ticketCh = await guild.channels.create({
        name,
        parent: String(cfg.ticketCategory),
        permissionOverwrites,
      });

      const SITE = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : (process.env.SITE_URL || "https://pejxjcykzlqjsloshvhbb-production.up.railway.app");

      const embed = new EmbedBuilder()
        .setTitle("🌐  Web Generation Ticket")
        .setDescription(`**${username}** a généré un compte depuis le site web.`)
        .setColor(meta.color)
        .addFields(
          { name: "👤 Membre",    value: `**${username}**`,                              inline: true  },
          { name: "📦 Service",   value: `**${service}**`,                               inline: true  },
          { name: "🏷️ Tier",     value: `${meta.emoji} **${meta.label}**`,              inline: true  },
          { name: "🔑 Code",      value: `\`\`\`${code}\`\`\``,                         inline: false },
          { name: "📋 Commande",  value: `\`/redeem ${code}\``,                          inline: false },
          { name: "🌐 Ticket web",value: `${SITE}/ticket.html?id=${ticketId}`,           inline: false },
        )
        .setFooter({ text: "Gen Bot • Web Generation" })
        .setTimestamp();

      // Ping staff ONLY — pas le membre (il est sur le site)
      await ticketCh.send({ content: `<@&${cfg.staffRole}>`, embeds: [embed] });

      // Enregistrer le mapping channel → ticket
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
