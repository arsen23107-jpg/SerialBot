const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const params = new URLSearchParams(window.location.search);
const series = params.get('series') || '';
const season = Number(params.get('season'));
const episode = Number(params.get('episode'));
const episodeLabel = document.getElementById('episodeLabel');
const timerElement = document.getElementById('timer');
const timerText = document.getElementById('timerText');
const status = document.getElementById('status');

episodeLabel.textContent = Number.isInteger(season) && Number.isInteger(episode) ? `Сезон ${season} · Серия ${episode}` : 'Параметры серии не найдены';

async function finishAdvertisement() {
  timerElement.textContent = '✓';
  timerText.textContent = 'Реклама завершена';
  status.textContent = 'Отправляем серию в Telegram…';
  try {
    const response = await fetch('/api/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ series, season, episode, initData: tg?.initData || '' }) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Не удалось получить серию');
    status.textContent = 'Серия отправлена. Закрываем окно…';
    setTimeout(() => tg?.close(), 700);
  } catch (error) {
    console.error(error);
    status.textContent = `Ошибка: ${error.message || 'попробуйте открыть рекламу снова'}`;
  }
}

let seconds = 10;
const countdown = setInterval(() => { seconds -= 1; timerElement.textContent = seconds; if (seconds <= 0) { clearInterval(countdown); finishAdvertisement(); } }, 1000);
