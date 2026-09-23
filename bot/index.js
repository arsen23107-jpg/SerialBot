require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const MINI_APP_URL = process.env.MINI_APP_URL;
const DATA_PATH = path.join(__dirname, '..', 'data', 'videos.json');

if (!BOT_TOKEN || !MINI_APP_URL) {
  console.error('ERROR: BOT_TOKEN and MINI_APP_URL must be configured in .env');
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const bot = new Telegraf(BOT_TOKEN);
const app = express();
const pendingGates = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));

function getSeries(seriesId) {
  return catalog.series.find((series) => series.id === seriesId);
}

function getEpisode(seriesId, seasonNumber, episodeNumber) {
  const series = getSeries(seriesId);
  const season = series?.seasons.find((item) => item.season === Number(seasonNumber));
  const episode = season?.episodes.find((item) => item.episode === Number(episodeNumber));
  return series && season && episode ? { series, season, episode } : null;
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function findSeries(query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  return catalog.series.filter((series) => normalizeSearchText(series.title).includes(normalizedQuery));
}

function verifyTelegramWebAppData(initData) {
  if (!initData || typeof initData !== 'string') return null;

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (receivedHash.length !== calculatedHash.length || !crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(calculatedHash))) {
      return null;
    }

    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? user : null;
  } catch (error) {
    console.error('Ошибка проверки Telegram initData:', error);
    return null;
  }
}

function miniAppUrl(seriesId, season, episode) {
  const url = new URL(MINI_APP_URL);
  url.searchParams.set('series', seriesId);
  url.searchParams.set('season', season);
  url.searchParams.set('episode', episode);
  return url.toString();
}

function navigationKeyboard(item) {
  const { series, season, episode } = item;
  const buttons = [];
  if (episode.episode > 1) buttons.push(Markup.button.callback('⬅️ Назад', `nav:${series.id}:${season.season}:${episode.episode - 1}`));
  buttons.push(Markup.button.callback(`Серия ${episode.episode}`, 'episode_info'));
  if (episode.episode < season.episodes.length) buttons.push(Markup.button.callback('Вперёд ➡️', `nav:${series.id}:${season.season}:${episode.episode + 1}`));
  return Markup.inlineKeyboard([buttons, [Markup.button.callback('🔎 К каталогу', 'start_search')]]);
}

function seriesCaption(series, seasonNumber = series.seasons[0]?.season) {
  const season = series.seasons.find((item) => item.season === Number(seasonNumber)) || series.seasons[0];
  const episodeCount = season?.episodes.length || 0;
  return `🎬 <b>${series.title}</b>\n\n${season.season} сезон • ${episodeCount} ${episodeCount === 1 ? 'серия' : 'серии'}\n\nВыбери серию. Каждая серия открывается после просмотра рекламы.`;
}

function seriesKeyboard(series, selectedSeason = series.seasons[0]?.season) {
  const season = series.seasons.find((item) => item.season === Number(selectedSeason)) || series.seasons[0];
  const seasonButtons = series.seasons.map((item) => Markup.button.callback(
    `${item.season === season.season ? '✓ ' : ''}${item.season} сезон`,
    `season:${series.id}:${item.season}`
  ));
  const episodeButtons = season.episodes.map((item) => Markup.button.callback(
    `▶️ Серия ${item.episode}`,
    `episode:${series.id}:${season.season}:${item.episode}`
  ));

  return Markup.inlineKeyboard([
    seasonButtons,
    episodeButtons,
    [Markup.button.callback('🔎 К каталогу', 'start_search')]
  ]);
}

async function sendSeriesCard(chatId, series, seasonNumber) {
  const imagePath = path.join(__dirname, '..', 'web', series.image);
  const options = {
    caption: seriesCaption(series, seasonNumber),
    parse_mode: 'HTML',
    ...seriesKeyboard(series, seasonNumber)
  };

  if (fs.existsSync(imagePath)) return bot.telegram.sendPhoto(chatId, { source: imagePath }, options);
  return bot.telegram.sendMessage(chatId, seriesCaption(series, seasonNumber), options);
}

function catalogKeyboard() {
  const icons = ['🎬', '🌑', '🚪', '🔢', '⏰'];
  return Markup.inlineKeyboard(catalog.series.map((series, index) => [
    Markup.button.callback(`${icons[index]} ${series.title}`, `series:${series.id}`)
  ]));
}

async function sendEpisodeGate(chatId, userId, item) {
  const { series, season, episode } = item;
  const message = await bot.telegram.sendPhoto(chatId, { source: path.join(__dirname, '..', 'web', series.image) }, {
    caption: `🎬 <b>${series.title}</b>\n\n${season.season} сезон • ${episode.episode} серия\n\nВидео откроется после просмотра рекламы.\n\nЖми кнопку «Смотреть рекламу», чтобы бесплатно открыть видео.`,
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.webApp('▶️ Смотреть рекламу', miniAppUrl(series.id, season.season, episode.episode))]])
  });

  pendingGates.set(String(userId), { chatId, messageId: message.message_id, seriesId: series.id, season: season.season, episode: episode.episode });
}

app.get('/api/health', (req, res) => res.json({ ok: true, message: 'Rocket Cinema server is working' }));

app.post('/api/watch', async (req, res) => {
  try {
    const user = verifyTelegramWebAppData(req.body?.initData);
    const seriesId = req.body?.series;
    const season = Number(req.body?.season);
    const episodeNumber = Number(req.body?.episode);
    const item = getEpisode(seriesId, season, episodeNumber);
    const gate = pendingGates.get(String(user?.id));

    if (!user) return res.status(401).json({ ok: false, error: 'Telegram initData недействителен' });
    if (!item || !gate || gate.seriesId !== seriesId || gate.season !== season || gate.episode !== episodeNumber) {
      return res.status(400).json({ ok: false, error: 'Рекламный доступ для этой серии не найден' });
    }

    const videoPath = path.join(__dirname, '..', 'videos', item.episode.video);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ ok: false, error: 'Видео не найдено' });

    pendingGates.delete(String(user.id));
    await bot.telegram.deleteMessage(gate.chatId, gate.messageId).catch(() => undefined);
    await bot.telegram.sendVideo(gate.chatId, { source: videoPath }, {
      caption: `🎬 <b>${item.series.title}</b>\n${item.season.season} сезон • ${item.episode.episode} серия`,
      parse_mode: 'HTML',
      ...navigationKeyboard(item)
    });
    return res.json({ ok: true, message: 'Серия отправлена в Telegram' });
  } catch (error) {
    console.error('Ошибка /api/watch:', error);
    return res.status(500).json({ ok: false, error: 'Не удалось отправить серию' });
  }
});

bot.start((ctx) => ctx.reply('👋 <b>Привет, киноман!</b>\n\n🔎 Для поиска сериала нажми кнопку снизу.', {
  parse_mode: 'HTML',
  ...Markup.inlineKeyboard([[Markup.button.callback('🔎 Начать поиск', 'start_search')]])
}));

bot.action('start_search', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => undefined);
  await ctx.reply('🔎 <b>Поиск сериалов</b>\n\nВыбери сериал из каталога:', {
    parse_mode: 'HTML',
    ...catalogKeyboard()
  });
});

bot.action(/^series:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const series = getSeries(ctx.match[1]);
  if (!series) return ctx.reply('❌ Сериал не найден.');
  await ctx.deleteMessage().catch(() => undefined);
  return sendSeriesCard(ctx.chat.id, series);
});

bot.action(/^season:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const series = getSeries(ctx.match[1]);
  const season = series?.seasons.find((item) => item.season === Number(ctx.match[2]));
  if (!series || !season) return ctx.reply('❌ Сезон не найден.');
  return ctx.editMessageCaption(seriesCaption(series, season.season), {
    parse_mode: 'HTML',
    ...seriesKeyboard(series, season.season)
  });
});

bot.action(/^episode:([^:]+):(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const item = getEpisode(ctx.match[1], ctx.match[2], ctx.match[3]);
  if (!item) return ctx.reply('❌ Серия не найдена.');
  await ctx.deleteMessage().catch(() => undefined);
  return sendEpisodeGate(ctx.chat.id, ctx.from.id, item);
});

bot.action(/^nav:([^:]+):(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const item = getEpisode(ctx.match[1], ctx.match[2], ctx.match[3]);
  if (!item) return ctx.reply('❌ Серия не найдена.');
  await ctx.deleteMessage().catch(() => undefined);
  return sendEpisodeGate(ctx.chat.id, ctx.from.id, item);
});

bot.action('episode_info', (ctx) => ctx.answerCbQuery('Текущая серия'));
bot.on('text', async (ctx) => {
  const query = ctx.message.text.trim();
  if (!query || query.startsWith('/')) return ctx.reply('Используй /start, чтобы открыть поиск сериалов.');

  const matches = findSeries(query);
  if (!matches.length) return ctx.reply(`🔎 По запросу «${query}» ничего не найдено.\n\nПопробуй: Последний рейс, Тёмный город, За гранью, Код 23 или Нулевой час.`);
  if (matches.length === 1) return sendSeriesCard(ctx.chat.id, matches[0]);

  return ctx.reply('🔎 <b>Результаты поиска</b>\n\nВыбери сериал:', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(matches.map((series) => [Markup.button.callback(`🎬 ${series.title}`, `series:${series.id}`)]))
  });
});
bot.catch((error) => console.error('BOT ERROR:', error));

async function launch() {
  await bot.telegram.setChatMenuButton({ menu_button: { type: 'default' } }).catch((error) => console.warn('Не удалось сбросить Menu Button:', error.description || error.message));
  app.listen(PORT, () => console.log(`Rocket Cinema запущен: http://localhost:${PORT}`));
  await bot.launch();
}

launch().catch((error) => { console.error('Не удалось запустить Rocket Cinema:', error); process.exit(1); });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
