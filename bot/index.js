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
const pendingSearches = new Set();
const searchGreetings = new Map();
const INLINE_MARKER_PREFIX = '\u2063';

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

function inlineResultMarker(seriesId) {
  const index = catalog.series.findIndex((series) => series.id === seriesId);
  return `${INLINE_MARKER_PREFIX}${'\u200B'.repeat(index + 1)}`;
}

async function removeSearchGreeting(userId) {
  const greeting = searchGreetings.get(String(userId));
  if (!greeting) return;
  await bot.telegram.deleteMessage(greeting.chatId, greeting.messageId).catch(() => undefined);
  searchGreetings.delete(String(userId));
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

function publicAssetUrl(relativePath) {
  return new URL(relativePath, MINI_APP_URL.endsWith('/') ? MINI_APP_URL : `${MINI_APP_URL}/`).toString();
}

function navigationKeyboard(item) {
  const { series, season, episode } = item;
  const buttons = [];
  if (episode.episode > 1) buttons.push(Markup.button.callback('⬅️ Назад', `nav:${series.id}:${season.season}:${episode.episode - 1}`));
  buttons.push(Markup.button.callback(`Серия ${episode.episode}`, `episodes:${series.id}:${season.season}`));
  if (episode.episode < season.episodes.length) buttons.push(Markup.button.callback('Вперёд ➡️', `nav:${series.id}:${season.season}:${episode.episode + 1}`));
  return Markup.inlineKeyboard([buttons, [Markup.button.switchToCurrentChat('🔎 Новый поиск', '')]]);
}

function seriesCaption(series) {
  const seasonCount = series.seasons.length;
  return `🎬 <b>${series.title}</b>\n\nДоступно сезонов: ${seasonCount}\n\nВыбери сезон, затем серию. Каждая серия открывается после просмотра рекламы.`;
}

function seriesKeyboard(series) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎞 Выбрать сезон', `seasons:${series.id}`)],
    [Markup.button.switchToCurrentChat('🔎 Новый поиск', '')]
  ]);
}

function seasonsKeyboard(series) {
  return Markup.inlineKeyboard([
    ...series.seasons.map((item) => [Markup.button.callback(`${item.season} сезон`, `episodes:${series.id}:${item.season}`)]),
    [Markup.button.callback('⬅️ К сериалу', `series:${series.id}`)]
  ]);
}

function episodesKeyboard(series, season) {
  return Markup.inlineKeyboard([
    ...season.episodes.map((item) => [Markup.button.callback(String(item.episode), `episode:${series.id}:${season.season}:${item.episode}`)]),
    [Markup.button.callback('⬅️ К сезонам', `seasons:${series.id}`)]
  ]);
}

async function sendSeriesCard(chatId, series) {
  const imagePath = path.join(__dirname, '..', 'web', series.image);
  const options = {
    caption: seriesCaption(series),
    parse_mode: 'HTML',
    ...seriesKeyboard(series)
  };

  if (fs.existsSync(imagePath)) return bot.telegram.sendPhoto(chatId, { source: imagePath }, options);
  return bot.telegram.sendMessage(chatId, seriesCaption(series), options);
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

bot.start(async (ctx) => {
  await ctx.deleteMessage().catch(() => undefined);
  const greeting = await ctx.reply('👋 <b>Привет, киноман!</b>\n\n🔎 Для поиска сериала нажми кнопку снизу.', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.switchToCurrentChat('🔎 Начать поиск', '')]])
  });
  searchGreetings.set(String(ctx.from.id), { chatId: ctx.chat.id, messageId: greeting.message_id });
});

bot.action('start_search', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => undefined);
  pendingSearches.add(String(ctx.from.id));
  await ctx.reply('🔎 <b>Поиск сериалов</b>\n\nНапиши название сериала или фильма сообщением.', { parse_mode: 'HTML' });
});

bot.action(/^series:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const series = getSeries(ctx.match[1]);
  if (!series) return ctx.reply('❌ Сериал не найден.');
  await ctx.deleteMessage().catch(() => undefined);
  return sendSeriesCard(ctx.chat.id, series);
});

bot.action(/^seasons:([^:]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const series = getSeries(ctx.match[1]);
  if (!series) return ctx.reply('❌ Сериал не найден.');
  return ctx.editMessageCaption(`🎬 <b>${series.title}</b>\n\nВыбери сезон:`, {
    parse_mode: 'HTML',
    ...seasonsKeyboard(series)
  });
});

bot.action(/^episodes:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const series = getSeries(ctx.match[1]);
  const season = series?.seasons.find((item) => item.season === Number(ctx.match[2]));
  if (!series || !season) return ctx.reply('❌ Сезон не найден.');
  return ctx.editMessageCaption(`🎬 <b>${series.title}</b>\n\n${season.season} сезон\n\nВыбери серию:`, {
    parse_mode: 'HTML',
    ...episodesKeyboard(series, season)
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

bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  const matches = query ? findSeries(query) : catalog.series;
  const results = matches.map((series) => ({
    type: 'article',
    id: series.id,
    title: series.title,
    description: `${series.seasons.length} сезон(а) • выбери сезон и серию`,
    thumb_url: publicAssetUrl(series.image),
    input_message_content: {
      message_text: inlineResultMarker(series.id)
    },
    reply_markup: { inline_keyboard: [] }
  }));
  await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
});

bot.on('text', async (ctx) => {
  const rawText = ctx.message.text || '';
  const inlineSeries = catalog.series.find((series) => rawText === inlineResultMarker(series.id));
  if (inlineSeries) {
    await ctx.deleteMessage().catch(() => undefined);
    await removeSearchGreeting(ctx.from.id);
    return sendSeriesCard(ctx.chat.id, inlineSeries);
  }
  const query = rawText.trim();
  if (!query || query.startsWith('/')) return ctx.reply('Используй /start, чтобы открыть поиск сериалов.');

  const waitingForSearch = pendingSearches.delete(String(ctx.from.id));
  if (!waitingForSearch) return ctx.reply('Нажми «🔎 Начать поиск», затем напиши название сериала.');

  const matches = findSeries(query);
  if (!matches.length) {
    pendingSearches.add(String(ctx.from.id));
    return ctx.reply(`🔎 По запросу «${query}» ничего не найдено.\n\nПопробуй: Последний рейс, Тёмный город, За гранью, Код 23 или Нулевой час.`);
  }
  if (matches.length === 1) return sendSeriesCard(ctx.chat.id, matches[0]);

  return ctx.reply('🔎 <b>Результаты поиска</b>\n\nВыбери сериал:', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(matches.map((series) => [Markup.button.callback(`🎬 ${series.title}`, `series:${series.id}`)]))
  });
});
bot.catch((error) => console.error('BOT ERROR:', error));

async function launch() {
  await bot.telegram.deleteMyCommands().catch((error) => console.warn('Не удалось очистить команды:', error.description || error.message));
  await bot.telegram.setChatMenuButton({ menu_button: { type: 'default' } }).catch((error) => console.warn('Не удалось сбросить Menu Button:', error.description || error.message));
  app.listen(PORT, () => console.log(`Rocket Cinema запущен: http://localhost:${PORT}`));
  await bot.launch({ allowedUpdates: ['message', 'callback_query', 'inline_query', 'chosen_inline_result'] });
}

launch().catch((error) => { console.error('Не удалось запустить Rocket Cinema:', error); process.exit(1); });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
