// Multi-language support (EN/FR) with i18n
export const messages = {
  en: {
    // General
    welcome: "Welcome to Gen Bot!",
    error: "An error occurred.",
    success: "Success!",
    cancelled: "Operation cancelled.",

    // Stock
    stockTitle: "📦 Stock Report",
    stockEmpty: "No accounts available.",
    totalAccounts: "Total Accounts",
    services: "Services",

    // Generation
    genTitle: "⚡ Generate Account",
    genSuccess: "Account generated successfully!",
    genCooldown: "Please wait **{time}** before generating again.",
    genNoStock: "This service is out of stock!",
    genSelectTier: "Select a tier",
    genSelectService: "Select a service",

    // Tiers
    free: "Free",
    premium: "Premium",
    booster: "Booster",
    extreme: "Extreme",

    // Errors
    accessDenied: "Access Denied",
    notConfigured: "Server not configured.",
    invalidTier: "Invalid tier selected.",
    noPermission: "You do not have permission to use this command.",

    // Tickets
    ticketCreated: "Ticket created successfully!",
    ticketClosed: "Ticket closed.",
    waitingValidation: "Waiting for staff validation...",

    // Feedback
    feedbackPrompt: "Please rate your generation experience:",
    feedbackThanks: "Thank you for your feedback!",

    // Announcements
    announcement: "📢 Announcement",

    // Cooldowns
    cooldownRemaining: "Cooldown remaining: {time}",
    noCooldown: "No cooldown active.",

    // Leaderboard
    leaderboardTitle: "🏆 Leaderboard",
    noGenerations: "No generations yet.",

    // Profile
    profileTitle: "👤 Profile",
    totalGens: "Total Generations",
    vouches: "Vouches",

    // Stock alerts
    lowStock: "⚠️ Low Stock Alert!",
    lowStockDesc: "**{service}** ({tier}) is running low on stock! Only **{count}** accounts left.",

    // Restock
    restockTitle: "📦 Restock Notification",
    restocked: "**{service}** ({tier}) has been restocked with **{count}** accounts!",

    // Announcement system
    announcementTitle: "📢 Broadcast Message",
    noUsers: "No users found to announce to.",
    announceSent: "Announcement sent to **{count}** users!",

    // Search
    searchResults: "🔍 Search Results",
    noResults: "No results found.",

    // Categories
    category: "Category",
    noCategory: "Uncategorized",
  },

  fr: {
    // General
    welcome: "Bienvenue sur Gen Bot !",
    error: "Une erreur est survenue.",
    success: "Succès !",
    cancelled: "Opération annulée.",

    // Stock
    stockTitle: "📦 Rapport de Stock",
    stockEmpty: "Aucun compte disponible.",
    totalAccounts: "Total des Comptes",
    services: "Services",

    // Generation
    genTitle: "⚡ Générer un Compte",
    genSuccess: "Compte généré avec succès !",
    genCooldown: "Veuillez attendre **{time}** avant de régénérer.",
    genNoStock: "Ce service est en rupture de stock !",
    genSelectTier: "Sélectionnez un niveau",
    genSelectService: "Sélectionnez un service",

    // Tiers
    free: "Gratuit",
    premium: "Premium",
    booster: "Booster",
    extreme: "Extrême",

    // Errors
    accessDenied: "Accès Refusé",
    notConfigured: "Serveur non configuré.",
    invalidTier: "Niveau invalide sélectionné.",
    noPermission: "Vous n'avez pas la permission d'utiliser cette commande.",

    // Tickets
    ticketCreated: "Ticket créé avec succès !",
    ticketClosed: "Ticket fermé.",
    waitingValidation: "En attente de validation par le staff...",

    // Feedback
    feedbackPrompt: "Veuillez évaluer votre expérience de génération :",
    feedbackThanks: "Merci pour votre retour !",

    // Announcements
    announcement: "📢 Annonce",

    // Cooldowns
    cooldownRemaining: "Temps restant : {time}",
    noCooldown: "Aucun cooldown actif.",

    // Leaderboard
    leaderboardTitle: "🏆 Classement",
    noGenerations: "Aucune génération pour le moment.",

    // Profile
    profileTitle: "👤 Profil",
    totalGens: "Générations Totales",
    vouches: "Vouches",

    // Stock alerts
    lowStock: "⚠️ Alerte Stock Faible !",
    lowStockDesc: "**{service}** ({tier}) a un stock faible ! Plus que **{count}** comptes.",

    // Restock
    restockTitle: "📦 Notification de Restock",
    restocked: "**{service}** ({tier}) a été restocké avec **{count}** comptes !",

    // Announcement system
    announcementTitle: "📢 Message Diffusé",
    noUsers: "Aucun utilisateur trouvé pour l'annonce.",
    announceSent: "Annonce envoyée à **{count}** utilisateurs !",

    // Search
    searchResults: "🔍 Résultats de Recherche",
    noResults: "Aucun résultat trouvé.",

    // Categories
    category: "Catégorie",
    noCategory: "Sans catégorie",
  }
};

// Default language
let defaultLang = "en";

export function setDefaultLang(lang) {
  if (messages[lang]) defaultLang = lang;
}

export function t(key, lang, vars = {}) {
  const l = messages[lang] ? lang : defaultLang;
  let str = messages[l][key] || messages.en[key] || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(`{${k}}`, v);
  }
  return str;
}

// Get user language from Discord or web session
export function getUserLang(user) {
  // Check if user has a language preference stored
  // For now, default to English
  return "en";
}
