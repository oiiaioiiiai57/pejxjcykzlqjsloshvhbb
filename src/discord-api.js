import { SITE } from "./config.js";

const BASE = "https://discord.com/api/v10";

function botHeaders() {
  return {
    Authorization:  `Bot ${process.env.TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function discordSend(channelId, body) {
  const res = await fetch(`${BASE}/channels/${channelId}/messages`, {
    method: "POST", headers: botHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`discordSend ${res.status}: ${t}`);
  }
  return res.json();
}

export async function discordLog(channelId, embed) {
  return discordSend(channelId, { embeds: [embed] });
}

export async function createDiscordTicket({ userId, username, service, tier, code, ticketId, guildCfg, guildId }) {
  const colors = { free: 0x57F287, premium: 0xA855F7, booster: 0x00C3FF, extreme: 0xFF3C5C };
  const name   = `web-${service.toLowerCase()}-${username.toLowerCase().slice(0,10)}-${Math.floor(Math.random()*9000+1000)}`;

  const chRes = await fetch(`${BASE}/guilds/${guildId}/channels`, {
    method: "POST", headers: botHeaders(),
    body: JSON.stringify({
      name,
      type: 0,
      parent_id: guildCfg.ticketCategory,
      permission_overwrites: [
        { id: guildId,              type: 0, deny: "1024" },           // @everyone no view
        { id: String(userId),       type: 1, deny: "1024" },           // member no view (web only)
        { id: guildCfg.staffRole,   type: 0, allow: "3072" },          // staff: view + send
        { id: String(process.env.BOT_ID || "0"), type: 1, allow: "3072" },
      ],
    }),
  });

  if (!chRes.ok) {
    const t = await chRes.text();
    throw new Error(`createDiscordTicket ${chRes.status}: ${t}`);
  }

  const channel   = await chRes.json();
  const channelId = channel.id;

  await discordSend(channelId, {
    content: `<@&${guildCfg.staffRole}>`,   // Ping staff only — NOT the member
    embeds: [{
      title:       "🌐  Web Generation Ticket",
      description: `**${username}** a généré un compte depuis le site web.`,
      color:       colors[tier] || 0x5865F2,
      fields: [
        { name: "👤 Membre",    value: `**${username}**`,          inline: true  },
        { name: "📦 Service",   value: `**${service}**`,           inline: true  },
        { name: "🏷️ Tier",     value: tier.toUpperCase(),          inline: true  },
        { name: "🔑 Code",      value: `\`\`\`${code}\`\`\``,     inline: false },
        { name: "📋 Commande",  value: `\`/redeem ${code}\``,      inline: false },
        { name: "🌐 Ticket web",value: `${SITE}/ticket.html?id=${ticketId}`, inline: false },
      ],
      footer:    { text: "Gen Bot • Web Generation" },
      timestamp: new Date().toISOString(),
    }],
  });

  return channelId;
}
