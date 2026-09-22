const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
}

const seriesGrid = document.getElementById('seriesGrid');
const catalogTitle = document.getElementById('catalogTitle');
const catalogDescription = document.getElementById('catalogDescription');
const episodeCount = document.getElementById('episodeCount');
const heroWatchButton = document.getElementById('heroWatchButton');
const adModal = document.getElementById('adModal');
const closeAdButton = document.getElementById('closeAdButton');
const selectedEpisode = document.getElementById('selectedEpisode');
const timerElement = document.getElementById('timer');
const timerText = document.getElementById('timerText');
const watchButton = document.getElementById('watchButton');
const status = document.getElementById('status');

let selectedEpisodeId = null;
let countdown = null;

function pluralizeEpisodes(count) {
  return `${count} ${count === 1 ? 'серия' : count < 5 ? 'серии' : 'серий'}`;
}

function renderEpisodes(episodes) {
  seriesGrid.innerHTML = episodes.map((episode) => `
    <article class="series-card">
      <div class="poster poster-${(episode.id - 1) % 5}">
        <span class="poster-number">${String(episode.id).padStart(2, '0')}</span>
        <span class="poster-label">ROCKET CINEMA</span>
        <div class="poster-title">${episode.title}</div>
      </div>
      <div class="card-details">
        <div>
          <h3>${episode.title}</h3>
          <p>Тестовый сериал · HD</p>
        </div>
        <button class="card-watch-button" type="button" data-episode-id="${episode.id}">Смотреть</button>
      </div>
    </article>
  `).join('');
}

async function loadCatalog() {
  try {
    const response = await fetch('/api/episodes');
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error('Не удалось загрузить каталог');
    }

    catalogTitle.textContent = data.series.title;
    catalogDescription.textContent = data.series.description;
    episodeCount.textContent = pluralizeEpisodes(data.episodes.length);
    renderEpisodes(data.episodes);
  } catch (error) {
    console.error(error);
    seriesGrid.innerHTML = '<div class="loading-card error-card">Не удалось загрузить каталог. Попробуйте открыть Mini App ещё раз.</div>';
    catalogTitle.textContent = 'Каталог недоступен';
    catalogDescription.textContent = 'Проверьте подключение к серверу.';
  }
}

function resetAdState() {
  clearInterval(countdown);
  timerElement.textContent = '10';
  timerText.textContent = 'Подождите немного…';
  status.textContent = 'Реклама начнётся автоматически';
  watchButton.disabled = true;
  watchButton.classList.remove('ready');
  watchButton.textContent = 'Подождите…';
}

function startCountdown() {
  let seconds = 10;

  countdown = setInterval(() => {
    seconds -= 1;
    timerElement.textContent = seconds;

    if (seconds > 0) {
      return;
    }

    clearInterval(countdown);
    timerElement.textContent = '✓';
    timerText.textContent = 'Реклама закончилась';
    status.textContent = 'Серия готова к просмотру';
    watchButton.disabled = false;
    watchButton.classList.add('ready');
    watchButton.textContent = 'Получить серию в Telegram';
  }, 1000);
}

function openAdvertisement(episodeId, title) {
  selectedEpisodeId = episodeId;
  selectedEpisode.textContent = `${title} скоро будет у вас`;
  resetAdState();
  adModal.classList.add('is-open');
  adModal.setAttribute('aria-hidden', 'false');
  startCountdown();
}

function closeAdvertisement() {
  clearInterval(countdown);
  adModal.classList.remove('is-open');
  adModal.setAttribute('aria-hidden', 'true');
}

heroWatchButton.addEventListener('click', () => {
  document.getElementById('catalog').scrollIntoView({ behavior: 'smooth' });
});

seriesGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-episode-id]');

  if (!button) {
    return;
  }

  const card = button.closest('.series-card');
  openAdvertisement(Number(button.dataset.episodeId), card.querySelector('h3').textContent);
});

closeAdButton.addEventListener('click', closeAdvertisement);

watchButton.addEventListener('click', async () => {
  if (watchButton.disabled || !selectedEpisodeId) {
    return;
  }

  watchButton.disabled = true;
  watchButton.textContent = 'Отправляем…';
  status.textContent = 'Отправляем серию в Telegram…';

  try {
    const response = await fetch('/api/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episode: selectedEpisodeId,
        initData: tg?.initData || ''
      })
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Ошибка');
    }

    status.textContent = '✅ Серия отправлена в Telegram';
    watchButton.textContent = '✅ Готово';

    setTimeout(() => tg?.close(), 1200);
  } catch (error) {
    console.error(error);
    status.textContent = `❌ ${error.message || 'Не удалось получить серию'}`;
    watchButton.disabled = false;
    watchButton.textContent = 'Попробовать снова';
  }
});

loadCatalog();
