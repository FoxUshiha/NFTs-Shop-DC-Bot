/**
 * NFTs Shop — Discord Bot
 * FULL VERSION — FIXED (VALIDATION ERROR RESOLVED)
 * Node.js >= 18 | discord.js v14
 */

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder
} = require('discord.js');

const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const crypto = require('crypto');

/* =========================
   CONFIG
========================= */

const BOT_NAME = 'NFTs Shop';
const MAX_FILE_MB = 8;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const PANEL_COOLDOWN_MS = 10 * 60 * 1000;
const ADD_ITEM_TIMEOUT_MS = 5 * 60 * 1000;
const SHOP_CONTEXT_TTL = 15 * 60 * 1000;

// SEM barra no final (importante)
const API_BASE = process.env.COIN_API_BASE || 'https://bank.foxsrv.net';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';

/* =========================
   CLIENT
========================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

async function safeReply(interaction, options, isUpdate = false) {
  try {
    // Verifica se a interação ainda é válida (menos de 3 minutos)
    const interactionAge = Date.now() - interaction.createdTimestamp;
    if (interactionAge > 180000) { // 3 minutos = 180000 ms
      console.log(`Interaction expired (${interactionAge}ms old), skipping reply`);
      return null;
    }

    if (interaction.replied || interaction.deferred) {
      if (isUpdate) {
        return await interaction.editReply(options);
      } else {
        return await interaction.followUp({ ...options, ephemeral: true });
      }
    } else {
      if (isUpdate) {
        return await interaction.update(options);
      } else {
        return await interaction.reply(options);
      }
    }
  } catch (error) {
    if (error.code === 40060 || error.message.includes('already acknowledged')) {
      // Interação já foi respondida, ignorar silenciosamente
      return null;
    }
    if (error.code === 10062) {
      // Unknown interaction - expirada
      console.log('Interaction expired (unknown), skipping');
      return null;
    }
    console.error('Erro ao responder interação:', error);
    return null; // Não throw, apenas retorna null
  }
}

// No index.js, adicione esta função
async function getOrCreateCoinUserId(discordUserId) {
  return new Promise((resolve) => {
    db.get(`SELECT card_code FROM users WHERE user_id = ?`, [discordUserId], async (err, row) => {
      if (row && row.card_code) {
        // Já tem cartão, pega o ownerId via API
        try {
          const res = await axios.post(`${API_BASE}/api/card/info`, {
            cardCode: row.card_code
          });
          if (res.data.success && res.data.userId) {
            resolve(res.data.userId);
          } else {
            resolve(discordUserId); // fallback
          }
        } catch (error) {
          resolve(discordUserId); // fallback
        }
      } else {
        // Não tem cartão ainda, usa Discord ID como fallback
        resolve(discordUserId);
      }
    });
  });
}

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post your public shop panel'),

  new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Open a user shop')
    .addUserOption(o =>
      o.setName('user')
       .setDescription('Shop owner')
       .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('additem')
    .setDescription('Add an item to your shop')
    .addStringOption(o =>
      o.setName('name')
       .setDescription('Item name')
       .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('price')
       .setDescription('Price in coins')
       .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('amount')
       .setDescription('Total stock amount')
       .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove an item from your shop')
    .addIntegerOption(o =>
      o.setName('number')
       .setDescription('Item number from your shop')
       .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show help and usage')
];


/* =========================
   DATABASE
========================= */

const db = new sqlite3.Database('./database.db');

db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      card_code TEXT,
      created_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shops (
      user_id TEXT PRIMARY KEY,
      reputation INTEGER DEFAULT 0,
      total_sales INTEGER DEFAULT 0,
      total_earned_sats INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      name TEXT,
      original_filename TEXT,
      price_sats INTEGER,
      size_bytes INTEGER,
      amount INTEGER,
      file BLOB,
      created_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      buyer_id TEXT,
      seller_id TEXT,
      item_id TEXT,
      price_sats INTEGER,
      tx_id TEXT,
      created_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      purchase_id TEXT PRIMARY KEY,
      voter_id TEXT,
      vote INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cooldowns (
      user_id TEXT PRIMARY KEY,
      panel_ts INTEGER
    )
  `);

  console.log('📦 Database ready');
});


/* =========================
   HELPERS
========================= */

const toSats = c => Math.floor(Number(c) * 1e8);
const fromSats = s => (Number(s) / 1e8).toFixed(8);
const uuid = () => crypto.randomUUID();
const now = () => Date.now();

function ensureUser(id) {
  db.run(`INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)`, [id, now()]);
  db.run(`INSERT OR IGNORE INTO shops (user_id) VALUES (?)`, [id]);
}

function getCooldown(id, cb) {
  db.get(`SELECT panel_ts FROM cooldowns WHERE user_id = ?`, [id], (_, r) => cb(r?.panel_ts || 0));
}

function setCooldown(id) {
  db.run(`
    INSERT INTO cooldowns (user_id, panel_ts)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET panel_ts = excluded.panel_ts
  `, [id, now()]);
}

/* =========================
   COIN API
========================= */

/* =========================
   COIN API - CORRIGIDO
========================= */

async function processPayment(cardCode, toId, amountCoins, retryCount = 0) {
  try {
    // O endpoint CORRETO é /api/transfer/card (não /api/card/pay)
    const res = await axios.post(`${API_BASE}/api/transfer/card`, {
      cardCode,
      toId,
      amount: Math.floor(Number(amountCoins) * 1e8) / 1e8
    }, {
      timeout: 15000 // Aumente para 15 segundos
    });
    
    // A resposta da API é { success: true, txId?, date? } quando funciona
    // ou { success: false } quando falha
    if (res.data?.success === true) {
      return { 
        success: true, 
        txId: res.data.txId, 
        date: res.data.date || new Date().toISOString(),
        method: 'api/transfer/card' 
      };
    }
    
    // Se não teve sucesso, retorna erro
    return { 
      success: false, 
      error: res.data?.error || 'Payment failed',
      raw: res.data 
    };
    
  } catch (error) {
    console.error('Payment error details:', {
      message: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status
    });
    
    // Tenta novamente se for erro de rede
    if (retryCount < 2 && (error.code === 'ECONNABORTED' || !error.response)) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return processPayment(cardCode, toId, amountCoins, retryCount + 1);
    }

    
    // Se foi 404, o endpoint não existe
    if (error.response?.status === 404) {
      return { 
        success: false, 
        error: 'API endpoint not found. Please contact admin.',
        status: 404 
      };
    }
    
    return { 
      success: false, 
      error: error.response?.data?.error || error.message || 'Network error',
      status: error.response?.status 
    };
  }
}

async function coinPayByCard(cardCode, toId, amountCoins) {
  return processPayment(cardCode, toId, amountCoins);
}


// Limpa sessões expiradas a cada minuto
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [userId, view] of shopViews.entries()) {
    if (view.expires < now) {
      shopViews.delete(userId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🔄 Limpas ${cleaned} sessões de shop expiradas`);
  }
}, 60000); // A cada minuto

// Limpa uploads pendentes expirados
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [userId, pending] of pendingItemUploads.entries()) {
    if (pending.expires < now) {
      pendingItemUploads.delete(userId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🔄 Limpos ${cleaned} uploads pendentes expirados`);
  }
}, 30000); // A cada 30 segundos

/* =========================
   STATE
========================= */

const pendingItemUploads = new Map();
const shopViews = new Map();

/* =========================
   READY + COMMAND REGISTRATION (FIXED)
========================= */

client.once('ready', async () => {
  console.log(`🛒 ${BOT_NAME} online as ${client.user.tag}`);

  try {
    // 🌍 GLOBAL (DM + fallback)
    await client.application.commands.set(COMMANDS);
    console.log('✅ Global commands registered');
  } catch (err) {
    console.error('❌ Failed to register global commands:', err);
  }

  // 🏠 REGISTRA EM TODAS AS GUILDS (instantâneo)
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(COMMANDS);
      console.log(`✅ Commands registered in guild: ${guild.name}`);
    } catch (err) {
      console.error(`❌ Failed to register commands in guild ${guild.id}:`, err);
    }
  }
});

client.on('guildCreate', async (guild) => {
  try {
    await guild.commands.set(COMMANDS);
    console.log(`🆕 Commands registered in new guild: ${guild.name}`);
  } catch (err) {
    console.error(`❌ Failed to register commands in new guild ${guild.id}:`, err);
  }
});



/* =========================
   PANEL BUTTON → OPEN SHOP
========================= */

/* =========================
   SHOP BUY BUTTON - SHOW MODAL
========================= */

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== 'shop_buy') return;

  const view = shopViews.get(interaction.user.id);
  if (!view || view.expires < Date.now()) {
    shopViews.delete(interaction.user.id);
    return await safeReply(interaction, {
      content: '❌ Shop session expired.',
      ephemeral: true
    });
  }

  const modal = new ModalBuilder()
    .setCustomId('buy_modal')
    .setTitle('🛒 Buy Item');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('item')
        .setLabel('Item name or number')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('card')
        .setLabel('Card code (optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(64)
    )
  );

  try {
    await interaction.showModal(modal);
  } catch (error) {
    console.error('Erro ao mostrar modal:', error);
    await safeReply(interaction, {
      content: '❌ Failed to open purchase form.',
      ephemeral: true
    });
  }
});

/* =========================
   /SHOP COMMAND (FIX)
========================= */

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'shop') return;

  const owner = interaction.options.getUser('user');
  if (!owner) {
    return await safeReply(interaction, {
      content: '❌ Invalid user.',
      ephemeral: true
    });
  }

  // Limpa views expiradas primeiro
  const nowTime = Date.now();
  for (const [key, view] of shopViews.entries()) {
    if (view.expires < nowTime) {
      shopViews.delete(key);
    }
  }

  // Salva contexto da loja
  shopViews.set(interaction.user.id, {
    ownerId: owner.id,
    page: 0,
    expires: nowTime + SHOP_CONTEXT_TTL
  });

  // Renderiza a loja
  return await renderShop(interaction, interaction.user.id, true);
});


/* =========================
   RENDER SHOP (PAGINATED)
========================= */

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  /* =========================
     OPEN SHOP (CRIA CONTEXTO)
  ========================= */
  if (interaction.customId.startsWith('open_shop_')) {
    const ownerId = interaction.customId.replace('open_shop_', '');

    const owner = await interaction.client.users.fetch(ownerId).catch(() => null);
    if (!owner) {
      return interaction.reply({
        ephemeral: true,
        content: '❌ Shop owner not found.'
      });
    }

    shopViews.set(interaction.user.id, {
      ownerId: owner.id,
      page: 0,
      expires: Date.now() + SHOP_CONTEXT_TTL
    });

    return renderShop(interaction, interaction.user.id, true);
  }

  /* =========================
     DAQUI PRA BAIXO: PRECISA CONTEXTO
  ========================= */
  const view = shopViews.get(interaction.user.id);
  if (!view || view.expires < Date.now()) {
    shopViews.delete(interaction.user.id);
    return safeReply(interaction, {
      content: '❌ Shop session expired.',
      ephemeral: true
    });
  }

  /* =========================
     PAGINAÇÃO
  ========================= */
  if (interaction.customId === 'shop_prev') {
    view.page = Math.max(0, view.page - 1);
    view.expires = Date.now() + SHOP_CONTEXT_TTL;
    return renderShop(interaction, interaction.user.id, false);
  }

  if (interaction.customId === 'shop_next') {
    view.page++;
    view.expires = Date.now() + SHOP_CONTEXT_TTL;
    return renderShop(interaction, interaction.user.id, false);
  }

  /* =========================
     VOTOS
  ========================= */
  if (interaction.customId === 'vote_up' || interaction.customId === 'vote_down') {
    const delta = interaction.customId === 'vote_up' ? 5 : -5;

    db.get(
      `
      SELECT p.id
      FROM purchases p
      LEFT JOIN votes v ON v.purchase_id = p.id
      WHERE p.buyer_id = ?
        AND p.seller_id = ?
        AND v.purchase_id IS NULL
      ORDER BY p.created_at DESC
      LIMIT 1
      `,
      [interaction.user.id, view.ownerId],
      (err, row) => {
        if (err || !row) {
          return interaction.reply({
            ephemeral: true,
            content: '❌ You must buy from this shop before voting.'
          });
        }

        db.run(
          `INSERT INTO votes (purchase_id, voter_id, vote) VALUES (?, ?, ?)`,
          [row.id, interaction.user.id, delta]
        );

        db.run(
          `
          UPDATE shops
          SET reputation = MAX(-1000, MIN(1000, reputation + ?))
          WHERE user_id = ?
          `,
          [delta, view.ownerId]
        );

        interaction.reply({
          ephemeral: true,
          content: delta > 0
            ? '✅ Positive vote recorded!'
            : '⚠️ Negative vote recorded.'
        });
      }
    );

    return;
  }
});


/* =========================
   /ADDITEM
========================= */

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'additem') return;

  const userId = interaction.user.id;
  const name = interaction.options.getString('name');
  const priceCoins = interaction.options.getString('price');
  const amount = interaction.options.getInteger('amount');

  const priceSats = toSats(priceCoins);

  if (priceSats <= 0 || amount <= 0) {
    return interaction.reply({
      ephemeral: true,
      content: '❌ Invalid price or amount.'
    });
  }

  ensureUser(userId);

  pendingItemUploads.set(userId, {
    name,
    priceSats,
    amount,
    expires: now() + ADD_ITEM_TIMEOUT_MS
  });

  interaction.reply({
    ephemeral: true,
    content: `📤 Send the file now (max ${MAX_FILE_MB}MB). You have 5 minutes.`
  });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'remove') return;

  const userId = interaction.user.id;
  const number = interaction.options.getInteger('number');

  if (number <= 0) {
    return interaction.reply({
      ephemeral: true,
      content: '❌ Invalid item number.'
    });
  }

  // Busca os itens do dono na MESMA ordem da shop
  db.all(
    `SELECT id, name FROM items WHERE owner_id = ? ORDER BY created_at ASC`,
    [userId],
    (err, items) => {
      if (err || !items.length) {
        return interaction.reply({
          ephemeral: true,
          content: '❌ Your shop is empty.'
        });
      }

      const item = items[number - 1];
      if (!item) {
        return interaction.reply({
          ephemeral: true,
          content: '❌ Item number not found.'
        });
      }

      // Remove definitivamente
      db.run(
        `DELETE FROM items WHERE id = ? AND owner_id = ?`,
        [item.id, userId],
        function () {
          if (this.changes === 0) {
            return interaction.reply({
              ephemeral: true,
              content: '❌ Failed to remove item.'
            });
          }

          interaction.reply({
            ephemeral: true,
            content: `🗑️ Item **${item.name}** removed from your shop.`
          });
        }
      );
    }
  );
});


client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'panel') return;

  const userId = interaction.user.id;

  ensureUser(userId);

  // cooldown simples para evitar spam
  getCooldown(userId, async (lastTs) => {
    if (Date.now() - lastTs < PANEL_COOLDOWN_MS) {
      const wait = Math.ceil((PANEL_COOLDOWN_MS - (Date.now() - lastTs)) / 1000);
      return interaction.reply({
        ephemeral: true,
        content: `⏳ Please wait ${wait}s before posting another panel.`
      });
    }

    setCooldown(userId);

    const embed = new EmbedBuilder()
      .setTitle('🛍️ Shop Panel')
      .setDescription(
        `Welcome to **${interaction.user.username}**'s shop!\n\n` +
        `Click the button below to browse items.`
      )
      .setColor(0x57f287)
      .setFooter({ text: 'Powered by Coin' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`open_shop_${userId}`)
        .setLabel('Open Shop')
        .setStyle(ButtonStyle.Success)
    );

    await interaction.reply({
      embeds: [embed],
      components: [row]
    });
  });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('open_shop_')) return;

  const ownerId = interaction.customId.replace('open_shop_', '');

  const owner = await interaction.client.users.fetch(ownerId).catch(() => null);
  if (!owner) {
    return interaction.reply({
      ephemeral: true,
      content: '❌ Shop owner not found.'
    });
  }

  // cria contexto da shop para quem clicou
  shopViews.set(interaction.user.id, {
    ownerId: owner.id,
    page: 0,
    expires: Date.now() + SHOP_CONTEXT_TTL
  });

  await renderShop(interaction, interaction.user.id, true);
});


/* =========================
   FILE UPLOAD HANDLER
========================= */

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.attachments.size) return;

  const pending = pendingItemUploads.get(message.author.id);
  if (!pending || pending.expires < now()) return;

const file = message.attachments.first();
const originalFilename = file.name; // ← COM extensão

  if (file.size > MAX_FILE_BYTES) {
    return message.reply(`❌ File too large. Max ${MAX_FILE_MB}MB.`);
  }

  const buffer = await axios.get(file.url, { responseType: 'arraybuffer' }).then(r => r.data);

db.run(
  `
  INSERT INTO items (
    id,
    owner_id,
    name,
    original_filename,
    price_sats,
    size_bytes,
    amount,
    file,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  [
    uuid(),
    message.author.id,
    pending.name,          // nome exibido na shop
    originalFilename,      // 🔥 nome real do arquivo com extensão
    pending.priceSats,
    file.size,
    pending.amount,
    buffer,
    now()
  ],
  (err) => {
    if (err) {
      console.error('Erro ao salvar item:', err);
      message.reply('❌ Failed to save item.');
      return;
    }

    pendingItemUploads.delete(message.author.id);
    message.reply(`✅ Item **${pending.name}** added to your shop.`);
  }
);
});


/* =========================
   BUY MODAL SUBMIT
========================= */

/* =========================
   BUY MODAL SUBMIT - PROCESS PURCHASE
========================= */

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isModalSubmit() || interaction.customId !== 'buy_modal') return;

  // defer seguro
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
  } catch {}

  const buyerId = interaction.user.id;
  const itemInput = interaction.fields.getTextInputValue('item')?.trim();
  const cardInput = interaction.fields.getTextInputValue('card')?.trim() || null;

  const view = shopViews.get(buyerId);
  if (!view || view.expires < Date.now()) {
    shopViews.delete(buyerId);
    return interaction.editReply('❌ Shop session expired.');
  }

  if (!itemInput) {
    return interaction.editReply('❌ Please specify an item.');
  }

  db.all(
    `SELECT * FROM items WHERE owner_id = ? ORDER BY created_at ASC`,
    [view.ownerId],
    async (err, items) => {
      if (err || !items?.length) {
        return interaction.editReply('❌ Item not found or out of stock.');
      }

      const idx = Number(itemInput);
      const item = !isNaN(idx)
        ? items[idx - 1]
        : items.find(i => i.name.toLowerCase() === itemInput.toLowerCase());

      if (!item || item.amount <= 0) {
        return interaction.editReply('❌ Item not found or out of stock.');
      }

      try {
        // resolve Coin userId do vendedor
        const sellerCoinId = await getOrCreateCoinUserId(view.ownerId);

        let payResult = null;

        // tenta card informado
        if (cardInput) {
          payResult = await coinPayByCard(
            cardInput,
            sellerCoinId,
            fromSats(item.price_sats)
          );
        }

        // fallback: card salvo do usuário
        if (!payResult?.success) {
          const buyerCard = await new Promise(resolve => {
            db.get(
              `SELECT card_code FROM users WHERE user_id = ?`,
              [buyerId],
              (_, r) => resolve(r?.card_code)
            );
          });

          if (!buyerCard) {
            return interaction.editReply(
              '❌ No card available. Provide a card code.'
            );
          }

          payResult = await coinPayByCard(
            buyerCard,
            sellerCoinId,
            fromSats(item.price_sats)
          );
        }

        if (!payResult?.success) {
          return interaction.editReply(
            '❌ Payment failed. Check card or balance.'
          );
        }

        // 🔒 ATÔMICO: reduz estoque apenas se ainda existir
        db.run(
          `
          UPDATE items
          SET amount = amount - 1
          WHERE id = ? AND amount > 0
          `,
          [item.id],
          function () {
            if (this.changes === 0) {
              return interaction.editReply('❌ Item sold out.');
            }

            const purchaseId = uuid();

            db.run(
              `
              INSERT INTO purchases
              (id, buyer_id, seller_id, item_id, price_sats, tx_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              `,
              [
                purchaseId,
                buyerId,
                view.ownerId,
                item.id,
                item.price_sats,
                payResult.txId || null,
                Date.now()
              ]
            );

            db.run(
              `
              UPDATE shops
              SET total_sales = total_sales + 1,
                  total_earned_sats = total_earned_sats + ?
              WHERE user_id = ?
              `,
              [item.price_sats, view.ownerId]
            );

            db.run(
              `DELETE FROM items WHERE id = ? AND amount <= 0`,
              [item.id]
            );

            const attachment = new AttachmentBuilder(item.file, {
  name: item.original_filename || item.name
});


            const receipt = `🧾 **Purchase Complete**
Item: ${item.name}
Price: ${fromSats(item.price_sats)} coins
Transaction: ${payResult.txId || 'N/A'}`;

            interaction.editReply({
              content: receipt,
              files: [attachment]
            });

            // tenta DM
            interaction.user
              .send({ content: receipt, files: [attachment] })
              .catch(() => {});
          }
        );
      } catch (error) {
        console.error('Purchase error:', error);
        interaction.editReply('❌ An error occurred during purchase.');
      }
    }
  );
});


/* =========================
   VOTES
========================= */



/* =========================
   SHOP PAGINATION BUTTONS
========================= */

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  
  const view = shopViews.get(interaction.user.id);
  if (!view || view.expires < Date.now()) {
    shopViews.delete(interaction.user.id);
    return await safeReply(interaction, {
      content: '❌ Shop session expired.',
      ephemeral: true
    });
  }

  if (interaction.customId === 'shop_prev') {
    view.page = Math.max(0, view.page - 1);
    view.expires = Date.now() + SHOP_CONTEXT_TTL;
    return await renderShop(interaction, interaction.user.id, false);
  }

  if (interaction.customId === 'shop_next') {
    view.page++;
    view.expires = Date.now() + SHOP_CONTEXT_TTL;
    return await renderShop(interaction, interaction.user.id, false);
  }
});

/* =========================
   Render Shop
========================= */

async function renderShop(interaction, viewerId, isFirstReply) {
  const view = shopViews.get(viewerId);
  if (!view) {
    return safeReply(interaction, {
      content: '❌ Shop session expired or not found.',
      ephemeral: true
    });
  }

  const PAGE_SIZE = 5;
  const offset = view.page * PAGE_SIZE;

  db.all(
    `SELECT id, name, price_sats, amount FROM items
     WHERE owner_id = ?
     ORDER BY created_at ASC
     LIMIT ? OFFSET ?`,
    [view.ownerId, PAGE_SIZE, offset],
    async (_, rows = []) => {

      let desc = '';
      rows.forEach((item, i) => {
        desc += `**${offset + i + 1}.** ${item.name} — **${fromSats(item.price_sats)}** coins *(x${item.amount})*\n`;
      });

      if (!desc) desc = '*This shop has no items available.*';

      db.get(
        `SELECT reputation FROM shops WHERE user_id = ?`,
        [view.ownerId],
        async (_, shop) => {

          const embed = new EmbedBuilder()
            .setTitle('🛍️ Shop')
            .setDescription(desc)
            .addFields({
              name: '⭐ Reputation',
              value: String(shop?.reputation ?? 0),
              inline: true
            })
            .setFooter({ text: `Page ${view.page + 1}` })
            .setColor(0x57f287);

          const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('shop_prev')
              .setLabel('◀')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(view.page === 0),

            new ButtonBuilder()
              .setCustomId('shop_buy')
              .setLabel('Buy')
              .setStyle(ButtonStyle.Success)
              .setDisabled(rows.length === 0),

            new ButtonBuilder()
              .setCustomId('shop_next')
              .setLabel('▶')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(rows.length < PAGE_SIZE)
          );

          const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('vote_up')
              .setEmoji('👍')
              .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
              .setCustomId('vote_down')
              .setEmoji('👎')
              .setStyle(ButtonStyle.Danger)
          );

          await safeReply(
            interaction,
            {
              embeds: [embed],
              components: [row1, row2],
              ephemeral: true
            },
            !isFirstReply
          );
        }
      );
    }
  );
}


/* =========================
   /HELP
========================= */

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'help') return;

  interaction.reply({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setTitle('🛒 NFTs Shop — Help')
        .setColor(0x5865f2)
        .setDescription(`
**Selling**
• /additem → add a file (max 8MB)
• Upload file within 5 minutes

**Buying**
• /shop @user
• Browse pages
• Buy via modal

**Voting**
• 👍 / 👎 after purchase
• One vote per purchase

**Panel**
• /panel → public shop panel

Powered by Coin
        `)
    ]
  });
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection:', error);
});

client.on('error', (error) => {
  console.error('Discord Client Error:', error);
});

/* =========================
   LOGIN
========================= */

client.login(process.env.DISCORD_TOKEN);
