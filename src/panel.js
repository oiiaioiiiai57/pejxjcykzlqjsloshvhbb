/**
 * /panel — Menu interactif pour configurer les IDs d'un serveur
 * Tout est sauvegardé dans guild_config.json sur GitHub
 */

import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} from "discord.js";
import { GUILDS, saveGuildConfig, getGuild } from "./config.js";

// Seul le owner du bot ou un admin peut utiliser /panel
function canUsePanel(member) {
  return member.permissions.has(0x8n); // ADMINISTRATOR
}

// ── EMBED PRINCIPAL DU PANEL ──────────────────────────────────
function buildPanelEmbed(guild, cfg) {
  const f = (id) => id ? `<#${id}>` : "❌ Non défini";
  const r = (id) => id ? `<@&${id}>` : "❌ Non défini";
  const rArr = (arr) => arr?.length ? arr.map(id => `<@&${id}>`).join(" ") : "❌ Aucun";

  return new EmbedBuilder()
    .setTitle(`⚙️  Panel de configuration — ${cfg.name || guild.name}`)
    .setColor(0x5865F2)
    .setThumbnail(guild.iconURL())
    .addFields(
      {
        name: "📺 Salons de génération",
        value: [
          `🟢 Free : ${f(cfg.freeChannel)}`,
          `🟣 Premium : ${f(cfg.premiumChannel)}`,
          `🟡 Paid : ${f(cfg.paidChannel)}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "🗂️ Autres salons",
        value: [
          `🎟️ Catégorie tickets : ${f(cfg.ticketCategory)}`,
          `📋 Logs : ${f(cfg.logChannel)}`,
        ].join("\n"),
        inline: true,
      },
      { name: "\u200b", value: "\u200b", inline: false },
      {
        name: "🛡️ Rôles staff",
        value: [
          `👮 Staff (ping tickets) : ${r(cfg.staffRole)}`,
          `🤝 Helper : ${r(cfg.helperRole)}`,
          `✏️ AddV : ${r(cfg.addvRole)}`,
          `⚡ Staff ID (no cooldown + paid) : ${r(cfg.staffRoleId)}`,
          `🔨 Mods : ${rArr(cfg.modRoles)}`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "🎭 Rôles tier (site web)",
        value: [
          `🟢 Free : ${rArr(cfg.tierRoles?.free)}`,
          `🟣 Premium : ${rArr(cfg.tierRoles?.premium)}`,
          `🟡 Paid : ${rArr(cfg.tierRoles?.paid)}`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "🏅 Paliers vouches",
        value: cfg.vouchTiers?.map(vt =>
          `**${vt.threshold}** vouches → ${rArr(vt.roles)}`
        ).join("\n") || "❌ Non défini",
        inline: false,
      },
    )
    .setFooter({ text: "Toutes les modifications sont sauvegardées sur GitHub • Persistent après restart" })
    .setTimestamp();
}

// ── BOUTONS DU PANEL ──────────────────────────────────────────
function buildPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel_channels").setLabel("📺 Salons").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel_roles").setLabel("🛡️ Rôles Staff").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel_tier_roles").setLabel("🎭 Rôles Tiers").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel_vouch_tiers").setLabel("🏅 Vouches").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel_refresh").setLabel("🔄 Actualiser").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── MODALS ────────────────────────────────────────────────────
function channelsModal(cfg) {
  return new ModalBuilder()
    .setCustomId("panel_modal_channels")
    .setTitle("📺 Configurer les salons")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("freeChannel").setLabel("Salon FREE (ID)").setStyle(TextInputStyle.Short)
          .setValue(cfg.freeChannel || "").setRequired(false).setPlaceholder("ex: 1234567890123456789"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("premiumChannel").setLabel("Salon PREMIUM (ID)").setStyle(TextInputStyle.Short)
          .setValue(cfg.premiumChannel || "").setRequired(false).setPlaceholder("ex: 1234567890123456789"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("paidChannel").setLabel("Salon PAID (ID)").setStyle(TextInputStyle.Short)
          .setValue(cfg.paidChannel || "").setRequired(false).setPlaceholder("ex: 1234567890123456789"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("ticketCategory").setLabel("Catégorie tickets (ID)").setStyle(TextInputStyle.Short)
          .setValue(cfg.ticketCategory || "").setRequired(false).setPlaceholder("ex: 1234567890123456789"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("logChannel").setLabel("Salon logs (ID)").setStyle(TextInputStyle.Short)
          .setValue(cfg.logChannel || "").setRequired(false).setPlaceholder("ex: 1234567890123456789"),
      ),
    );
}

function rolesModal(cfg) {
  return new ModalBuilder()
    .setCustomId("panel_modal_roles")
    .setTitle("🛡️ Configurer les rôles staff")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("staffRole").setLabel("Rôle Staff — ping tickets (ID)").setStyle(TextInputStyle.Short)
          .setValue(cfg.staffRole || "").setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("helperRole").setLabel("Rôle Helper (ID)").setStyle(TextInputStyle.Short)
          .setValue(cfg.helperRole || "").setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("addvRole").setLabel("Rôle AddV (ID)").setStyle(TextInputStyle.Short)
          .setValue(cfg.addvRole || "").setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("staffRoleId").setLabel("Staff ID — no cooldown + tier paid site (ID)").setStyle(TextInputStyle.Short)
          .setValue(cfg.staffRoleId || "").setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("modRoles").setLabel("Rôles Mod (IDs séparés par des virgules)").setStyle(TextInputStyle.Paragraph)
          .setValue(cfg.modRoles?.join(",") || "").setRequired(false)
          .setPlaceholder("123456,789012,345678"),
      ),
    );
}

function tierRolesModal(cfg) {
  return new ModalBuilder()
    .setCustomId("panel_modal_tier_roles")
    .setTitle("🎭 Rôles tiers (site web)")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("tierFree").setLabel("Rôles FREE (IDs séparés par des virgules)").setStyle(TextInputStyle.Short)
          .setValue(cfg.tierRoles?.free?.join(",") || "").setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("tierPremium").setLabel("Rôles PREMIUM (IDs séparés par des virgules)").setStyle(TextInputStyle.Short)
          .setValue(cfg.tierRoles?.premium?.join(",") || "").setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("tierPaid").setLabel("Rôles PAID (IDs séparés par des virgules)").setStyle(TextInputStyle.Short)
          .setValue(cfg.tierRoles?.paid?.join(",") || "").setRequired(false),
      ),
    );
}

function vouchTiersModal(cfg) {
  // On met les 3 paliers dans un seul modal (format: "seuil:id1,id2|seuil:id")
  const fmt = cfg.vouchTiers?.map(vt => `${vt.threshold}:${vt.roles.join(",")}`).join("\n") || "";
  return new ModalBuilder()
    .setCustomId("panel_modal_vouch_tiers")
    .setTitle("🏅 Paliers de vouches")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("vouchTiers")
          .setLabel("Paliers (un par ligne : seuil:roleID,roleID)")
          .setStyle(TextInputStyle.Paragraph)
          .setValue(fmt)
          .setRequired(false)
          .setPlaceholder("40:123456,789012\n60:345678\n100:901234"),
      ),
    );
}

// ── PARSE HELPERS ─────────────────────────────────────────────
function parseIds(str) {
  return str.split(",").map(s => s.trim()).filter(s => /^\d+$/.test(s));
}

function parseId(str) {
  const s = str.trim();
  return /^\d+$/.test(s) ? s : null;
}

function parseVouchTiers(str) {
  return str.split("\n").map(line => {
    const [threshStr, rolesStr] = line.split(":");
    const threshold = parseInt(threshStr?.trim());
    const roles = parseIds(rolesStr || "");
    if (isNaN(threshold) || roles.length === 0) return null;
    return { threshold, roles };
  }).filter(Boolean).sort((a,b) => a.threshold - b.threshold);
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────
export async function handlePanel(interaction) {
  const guildId = String(interaction.guild.id);

  // ── Commande /panel ──────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
    if (!canUsePanel(interaction.member)) {
      return interaction.reply({ content: "❌ Tu dois être **Administrateur** pour utiliser `/panel`.", ephemeral: true });
    }
    // S'assurer que la guild est dans la config
    if (!GUILDS[guildId]) {
      GUILDS[guildId] = {
        name: interaction.guild.name,
        freeChannel: null, premiumChannel: null, paidChannel: null,
        ticketCategory: null, logChannel: null,
        staffRole: null, helperRole: null, addvRole: null,
        modRoles: [], staffRoleId: null,
        vouchTiers: [], tierRoles: { free: [], premium: [], paid: [] },
      };
      await saveGuildConfig();
    }
    const cfg = GUILDS[guildId];
    return interaction.reply({
      embeds:     [buildPanelEmbed(interaction.guild, cfg)],
      components: buildPanelButtons(),
      ephemeral:  true,
    });
  }

  // ── Boutons ───────────────────────────────────────────────────
  if (interaction.isButton()) {
    if (!canUsePanel(interaction.member)) {
      return interaction.reply({ content: "❌ Accès refusé.", ephemeral: true });
    }
    const cfg = GUILDS[guildId];
    if (!cfg) return interaction.reply({ content: "❌ Config introuvable.", ephemeral: true });

    if (interaction.customId === "panel_refresh") {
      return interaction.update({
        embeds:     [buildPanelEmbed(interaction.guild, cfg)],
        components: buildPanelButtons(),
      });
    }
    if (interaction.customId === "panel_channels")    return interaction.showModal(channelsModal(cfg));
    if (interaction.customId === "panel_roles")       return interaction.showModal(rolesModal(cfg));
    if (interaction.customId === "panel_tier_roles")  return interaction.showModal(tierRolesModal(cfg));
    if (interaction.customId === "panel_vouch_tiers") return interaction.showModal(vouchTiersModal(cfg));
  }

  // ── Modals ────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    if (!canUsePanel(interaction.member)) {
      return interaction.reply({ content: "❌ Accès refusé.", ephemeral: true });
    }
    if (!GUILDS[guildId]) return interaction.reply({ content: "❌ Config introuvable.", ephemeral: true });

    const cfg = GUILDS[guildId];
    const f   = (id) => interaction.fields.getTextInputValue(id);

    if (interaction.customId === "panel_modal_channels") {
      if (parseId(f("freeChannel")))    cfg.freeChannel    = parseId(f("freeChannel"));
      if (parseId(f("premiumChannel"))) cfg.premiumChannel = parseId(f("premiumChannel"));
      if (parseId(f("paidChannel")))    cfg.paidChannel    = parseId(f("paidChannel"));
      if (parseId(f("ticketCategory"))) cfg.ticketCategory = parseId(f("ticketCategory"));
      if (parseId(f("logChannel")))     cfg.logChannel     = parseId(f("logChannel"));
    }

    if (interaction.customId === "panel_modal_roles") {
      if (parseId(f("staffRole")))   cfg.staffRole   = parseId(f("staffRole"));
      if (parseId(f("helperRole")))  cfg.helperRole  = parseId(f("helperRole"));
      if (parseId(f("addvRole")))    cfg.addvRole    = parseId(f("addvRole"));
      if (parseId(f("staffRoleId"))) cfg.staffRoleId = parseId(f("staffRoleId"));
      const mods = parseIds(f("modRoles"));
      if (mods.length) cfg.modRoles = mods;
    }

    if (interaction.customId === "panel_modal_tier_roles") {
      if (!cfg.tierRoles) cfg.tierRoles = { free: [], premium: [], paid: [] };
      const fr = parseIds(f("tierFree"));
      const pr = parseIds(f("tierPremium"));
      const pa = parseIds(f("tierPaid"));
      if (fr.length) cfg.tierRoles.free    = fr;
      if (pr.length) cfg.tierRoles.premium = pr;
      if (pa.length) cfg.tierRoles.paid    = pa;
    }

    if (interaction.customId === "panel_modal_vouch_tiers") {
      const parsed = parseVouchTiers(f("vouchTiers"));
      if (parsed.length) cfg.vouchTiers = parsed;
    }

    // Sauvegarder sur GitHub
    await saveGuildConfig();

    return interaction.reply({
      content:    "✅ Configuration sauvegardée sur GitHub !",
      embeds:     [buildPanelEmbed(interaction.guild, cfg)],
      components: buildPanelButtons(),
      ephemeral:  true,
    });
  }
}
