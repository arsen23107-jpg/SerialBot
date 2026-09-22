require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is not configured in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(cors());
app.use(express.json());

/*
|--------------------------------------------------------------------------
| MINI APP
|--------------------------------------------------------------------------
*/

app.use(express.static(path.join(__dirname, '..', 'web')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

/*
|--------------------------------------------------------------------------
| TEST SERIES
|--------------------------------------------------------------------------
*/

const episodes = Array.from({ length: 10 }, (_, index) => {
  const number = index + 1;

  return {
    id: number,
    title: `Серия ${number}`,
    file: `${number}.mp4`
  };
});

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function getEpisode(episodeId) {
  return episodes.find((episode) => episode.id === episodeId);
}

function getVideoPath(episode) {
  return path.join(
    __dirname,
    '..',
    'videos',
    episode.file
  );
}

/*
|--------------------------------------------------------------------------
| TELEGRAM MINI APP INIT DATA
|--------------------------------------------------------------------------
|
| Telegram.WebApp.initData приходит из Mini App.
| Сервер проверяет его подпись через BOT_TOKEN.
|
|--------------------------------------------------------------------------
*/

function verifyTelegramWebAppData(initData) {
  if (!initData || typeof initData !== 'string') {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);

    const receivedHash = params.get('hash');

    if (!receivedHash) {
      return null;
    }

    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const hashesAreEqual =
      receivedHash.length === calculatedHash.length &&
      crypto.timingSafeEqual(
        Buffer.from(receivedHash),
        Buffer.from(calculatedHash)
      );

    if (!hashesAreEqual) {
      return null;
    }

    const userString = params.get('user');

    if (!userString) {
      return null;
    }

    const user = JSON.parse(userString);

    if (!user || !user.id) {
      return null;
    }

    return user;
  } catch (error) {
    console.error('Ошибка проверки Telegram initData:', error);
    return null;
  }
}

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'SerialBot server is working'
  });
});

/*
|--------------------------------------------------------------------------
| MINI APP WATCH
|--------------------------------------------------------------------------
*/

app.post('/api/watch', async (req, res) => {
  try {
    const episodeId = Number(req.body?.episode);
    const initData = req.body?.initData;

    if (!Number.isInteger(episodeId)) {
      return res.status(400).json({
        ok: false,
        error: 'Некорректный номер серии'
      });
    }

    const episode = getEpisode(episodeId);

    if (!episode) {
      return res.status(404).json({
        ok: false,
        error: 'Серия не найдена'
      });
    }

    const user = verifyTelegramWebAppData(initData);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Telegram initData недействителен'
      });
    }

    const videoPath = getVideoPath(episode);

    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({
        ok: false,
        error: 'Видео не найдено'
      });
    }

    console.log('');
    console.log('===== MINI APP WATCH =====');
    console.log(`Telegram user ID: ${user.id}`);
    console.log(`Username: ${user.username || 'нет'}`);
    console.log(`Серия: ${episode.id}`);
    console.log(`Файл: ${episode.file}`);
    console.log('==========================');

    await bot.telegram.sendVideo(
      user.id,
      {
        source: videoPath
      },
      {
        caption: `🎬 Тестовый сериал\n${episode.title}`
      }
    );

    console.log(`Видео отправлено пользователю ${user.id}`);

    return res.json({
      ok: true,
      message: 'Серия отправлена в Telegram'
    });
  } catch (error) {
    console.error('Ошибка /api/watch:', error);

    return res.status(500).json({
      ok: false,
      error: 'Не удалось отправить серию'
    });
  }
});

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

bot.start(async (ctx) => {
  await ctx.reply(
    '🎬 Добро пожаловать!\n\nВыбери сериал:',
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '🍿 Тестовый сериал',
          'series_test'
        )
      ]
    ])
  );
});

/*
|--------------------------------------------------------------------------
| SERIES
|--------------------------------------------------------------------------
*/

bot.action('series_test', async (ctx) => {
  await ctx.answerCbQuery();

  const buttons = episodes.map((episode) => [
    Markup.button.callback(
      `▶️ ${episode.title}`,
      `episode_${episode.id}`
    )
  ]);

  await ctx.editMessageText(
    '🍿 Тестовый сериал\n\nВыбери серию:',
    Markup.inlineKeyboard(buttons)
  );
});

/*
|--------------------------------------------------------------------------
| EPISODE
|--------------------------------------------------------------------------
*/

bot.action(/^episode_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const episodeId = Number(ctx.match[1]);
  const episode = getEpisode(episodeId);

  if (!episode) {
    return ctx.reply('❌ Серия не найдена.');
  }

  await ctx.reply(
    `🎬 ${episode.title}\n\n` +
    `Видео: ${episode.file}\n\n` +
    `Нажми кнопку ниже:`,
    Markup.inlineKeyboard([
      [
        Markup.button.webApp(
          '🌐 Открыть просмотр',
          `https://example.com/?episode=${episode.id}`
        )
      ],
      [
        Markup.button.callback(
          '▶️ Смотреть напрямую',
          `watch_${episode.id}`
        )
      ],
      [
        Markup.button.callback(
          '⬅️ К сериям',
          'series_test'
        )
      ]
    ])
  );
});

/*
|--------------------------------------------------------------------------
| DIRECT VIDEO
|--------------------------------------------------------------------------
|
| Старая рабочая функция остаётся.
| Она нужна для проверки и как резервный вариант.
|
|--------------------------------------------------------------------------
*/

bot.action(/^watch_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const episodeId = Number(ctx.match[1]);
  const episode = getEpisode(episodeId);

  if (!episode) {
    return ctx.reply('❌ Серия не найдена.');
  }

  const videoPath = getVideoPath(episode);

  console.log(`Запрошено видео: ${episode.file}`);
  console.log(`Путь: ${videoPath}`);

  if (!fs.existsSync(videoPath)) {
    return ctx.reply(
      `⚠️ Видео не найдено.\n\n` +
      `Бот искал файл:\n${episode.file}\n\n` +
      `Путь:\n${videoPath}`
    );
  }

  try {
    await ctx.replyWithVideo(
      { source: videoPath },
      {
        caption: `🎬 Тестовый сериал\n${episode.title}`
      }
    );

    console.log(`Видео отправлено: ${episode.file}`);
  } catch (error) {
    console.error('Ошибка отправки видео:', error);

    await ctx.reply(
      '❌ Не удалось отправить видео. ' +
      'Посмотри ошибку в Terminal.'
    );
  }
});

/*
|--------------------------------------------------------------------------
| TEXT
|--------------------------------------------------------------------------
*/

bot.on('text', async (ctx) => {
  await ctx.reply(
    'Используй /start, чтобы открыть каталог.'
  );
});

/*
|--------------------------------------------------------------------------
| ERRORS
|--------------------------------------------------------------------------
*/

bot.catch((error) => {
  console.error('BOT ERROR:', error);
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
  console.log('');
  console.log('=================================');
  console.log('SerialBot запущен');
  console.log('=================================');
  console.log(`HTTP: http://localhost:${PORT}`);
  console.log('Telegram bot: ONLINE');
  console.log('Mini App: ENABLED');
  console.log('Видео: 1.mp4 — 10.mp4');
  console.log('=================================');
  console.log('');
});

bot.launch();

/*
|--------------------------------------------------------------------------
| SHUTDOWN
|--------------------------------------------------------------------------
*/

process.once('SIGINT', () => {
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
});
