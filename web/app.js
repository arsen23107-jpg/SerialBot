const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
}

const params = new URLSearchParams(
  window.location.search
);

const episode = Number(
  params.get('episode') || 1
);

const episodeTitle =
  document.getElementById('episodeTitle');

const timerElement =
  document.getElementById('timer');

const timerText =
  document.getElementById('timerText');

const watchButton =
  document.getElementById('watchButton');

const status =
  document.getElementById('status');

episodeTitle.textContent =
  `Тестовый сериал · Серия ${episode}`;

let seconds = 10;

timerElement.textContent = seconds;

const countdown = setInterval(() => {

  seconds -= 1;

  timerElement.textContent = seconds;

  if (seconds > 0) {
    timerText.textContent =
      'Подождите немного...';

    return;
  }

  clearInterval(countdown);

  timerElement.textContent = '✓';

  timerText.textContent =
    'Реклама закончилась';

  watchButton.disabled = false;

  watchButton.classList.add('ready');

  watchButton.textContent =
    '🎬 Получить серию';

  status.textContent =
    'Серия готова к просмотру';

}, 1000);


watchButton.addEventListener(
  'click',
  async () => {

    if (watchButton.disabled) {
      return;
    }

    watchButton.disabled = true;

    watchButton.textContent =
      '⏳ Получаем серию...';

    status.textContent =
      'Отправляем запрос серверу...';

    try {

      const response = await fetch(
        '/api/watch',
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json'
          },

          body: JSON.stringify({
            episode
          })
        }
      );

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(
          data.error || 'Ошибка'
        );
      }

      status.textContent =
        '✅ Серия отправлена в Telegram';

      watchButton.textContent =
        '✅ Готово';

      setTimeout(() => {

        if (tg) {
          tg.close();
        }

      }, 1200);

    } catch (error) {

      console.error(error);

      status.textContent =
        '❌ Не удалось получить серию';

      watchButton.disabled = false;

      watchButton.textContent =
        '🎬 Попробовать снова';
    }
  }
);
