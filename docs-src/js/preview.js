// Preview of a saved game as the big screen (view.js) would show it —
// no server, no host, no teams: the whole game is laid out as a list of
// screens (game intro, then per stage: its intro, its questions, its
// correct answers) and stepped through with the fixed bar at the bottom
// (or ←/→ keys). A music question gets ▶/II and ■ buttons: ▶ starts from
// the "nuo" mark (or resumes after II), ■ stops and rewinds to it, and the
// clip stops by itself at "iki", just like the host's clip playback. A
// question with a picture (or picture options) also gets a fullscreen toggle
// (or F), like the host's one — the overlay stops above the bar.
const params = new URLSearchParams(window.location.search);
const gameId = params.get('id');

const gameIntroEl = document.getElementById('game-intro-screen');
const gameIntroNameEl = document.getElementById('game-intro-name');

const stageIntroEl = document.getElementById('stage-intro-screen');
const stageIntroLabelEl = document.getElementById('stage-intro-label');
const stageIntroNameEl = document.getElementById('stage-intro-name');

const questionAreaEl = document.getElementById('view-question');
const questionBoxEl = document.getElementById('view-question-box');
const imageWrapEl = document.getElementById('view-image-wrap');
const imageEl = document.getElementById('view-image');
const questionTextEl = document.getElementById('view-question-text');
const optionsEl = document.getElementById('view-options');
const stageReviewEl = document.getElementById('stage-review');
const errorEl = document.getElementById('preview-error');

const audioEl = document.getElementById('view-audio');
const audioProgressWrap = document.getElementById('audio-progress-wrap');
const audioProgressFill = document.getElementById('audio-progress-fill');

const prevBtn = document.getElementById('preview-prev');
const nextBtn = document.getElementById('preview-next');
const audioBtn = document.getElementById('preview-audio');
const audioStopBtn = document.getElementById('preview-audio-stop');
const counterEl = document.getElementById('preview-counter');
const fullscreenBtn = document.getElementById('preview-fullscreen');
const overlayEl = document.getElementById('fullscreen-overlay');
const overlayContentEl = document.getElementById('fullscreen-content');

const resolveMedia = QuizMediaPreview.resolve;

let screens = [];
let current = 0;

// The clip of the question on screen: start = "nuo" (0 if empty), end =
// "iki" (null = the recording's natural end).
let clipStart = 0;
let clipEnd = null;
// Set when paused mid-clip, so the next play resumes there; cleared on
// leaving the question and when the clip stops by itself at "iki".
let clipPaused = false;

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Same layout as view.js: 2 -> 2x1, 3 -> 3x1, 4 -> 2x2, 5-6 -> 3x2, ...
function pickGridSize(n) {
  if (n <= 3) return { cols: Math.max(n, 1), rows: 1 };
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

function createOptionLetter(index) {
  const badge = document.createElement('span');
  badge.className = 'option-letter';
  badge.textContent = String.fromCharCode(65 + index);
  return badge;
}

// The first option is the correct one in a stored game (see
// normalizeGamePayload), so options are shuffled — once, when the preview
// opens, so going back and forth doesn't reorder them — as the server does.
function buildScreens(game) {
  const list = [{ type: 'game-intro', name: game.name }];
  game.stages.forEach((stage, s) => {
    list.push({ type: 'stage-intro', name: stage.name, number: s + 1, count: game.stages.length });
    const shownOptions = stage.questions.map((q) => (q.options.length === 1 ? [] : shuffle(q.options)));
    stage.questions.forEach((q, i) => {
      list.push({
        type: 'question',
        number: i + 1,
        question: q,
        textAnswer: q.options.length === 1,
        options: shownOptions[i],
      });
    });
    list.push({ type: 'stage-answers', stage, shownOptions });
  });
  return list;
}

function stopAudio() {
  clipPaused = false;
  audioEl.pause();
  syncAudioButton();
}

function hideAll() {
  gameIntroEl.hidden = true;
  stageIntroEl.hidden = true;
  questionAreaEl.hidden = true;
  stageReviewEl.hidden = true;
  audioBtn.hidden = true;
  audioStopBtn.hidden = true;
  fullscreenBtn.hidden = true;
  closeFullscreen(true);
  stopAudio();
}

function showQuestion(screen) {
  const q = screen.question;
  questionAreaEl.hidden = false;
  questionTextEl.textContent = `${screen.number}. ${q.question}`;

  const audioSrc = resolveMedia(q.audio);
  clipStart = q.audioStart || 0;
  clipEnd = q.audioEnd != null ? q.audioEnd : null;
  if (audioSrc) {
    if (audioEl.getAttribute('src') !== audioSrc) audioEl.src = audioSrc;
  } else {
    audioEl.removeAttribute('src');
    audioEl.load();
  }
  audioBtn.hidden = !audioSrc;
  audioStopBtn.hidden = !audioSrc;
  audioProgressWrap.hidden = !audioSrc;
  audioProgressFill.style.width = '0%';

  const imgSrc = resolveMedia(q.img);
  questionBoxEl.classList.toggle('has-image', !!imgSrc);
  imageWrapEl.hidden = !imgSrc;
  if (imgSrc) imageEl.src = imgSrc;

  const optionsAreImages = screen.options.length > 0 && screen.options.every((opt) => opt.img);
  fullscreenBtn.hidden = !imgSrc && !optionsAreImages;
  optionsEl.className = optionsAreImages ? 'options-grid image-options' : 'options-list';
  optionsEl.innerHTML = '';
  if (optionsAreImages) {
    const { cols, rows } = pickGridSize(screen.options.length);
    optionsEl.style.setProperty('--cols', cols);
    optionsEl.style.setProperty('--rows', rows);
  }

  if (screen.textAnswer) {
    const hint = document.createElement('div');
    hint.className = 'view-text-answer-hint';
    hint.textContent = 'Įrašykite atsakymą';
    optionsEl.appendChild(hint);
    return;
  }
  screen.options.forEach((opt, i) => {
    const div = document.createElement('div');
    div.className = 'view-option';
    if (opt.img) {
      const imgEl = document.createElement('img');
      imgEl.src = resolveMedia(opt.img);
      imgEl.alt = ''; // never any text — it could give the answer away
      div.append(imgEl, createOptionLetter(i));
    } else {
      div.textContent = opt.text;
    }
    optionsEl.appendChild(div);
  });
}

// The correct option is the first one in a stored game; a picture option is
// named by the letter it had on its question's screen, like buildStageReview
// in server.js does.
function correctAnswerText(q, shown) {
  const correct = q.options[0];
  const shownIndex = shown.indexOf(correct);
  if (correct.img && shownIndex >= 0) return String.fromCharCode(65 + shownIndex);
  return correct.text || '—';
}

function showStageAnswers(stage, shownOptions) {
  stageReviewEl.hidden = false;
  stageReviewEl.innerHTML = '';

  const title = document.createElement('p');
  title.className = 'leaderboard-title';
  title.textContent = `Teisingi atsakymai: ${stage.name}`;
  stageReviewEl.appendChild(title);

  stage.questions.forEach((q, i) => {
    const box = document.createElement('div');
    box.className = 'question';
    const questionP = document.createElement('p');
    questionP.textContent = `${i + 1}. ${q.question}`;
    const answerP = document.createElement('p');
    answerP.className = 'correct-answer';
    answerP.textContent = correctAnswerText(q, shownOptions[i]);
    box.append(questionP, answerP);
    stageReviewEl.appendChild(box);
  });
}

function render() {
  hideAll();
  const screen = screens[current];
  if (screen.type === 'game-intro') {
    gameIntroEl.hidden = false;
    gameIntroNameEl.textContent = screen.name;
  } else if (screen.type === 'stage-intro') {
    stageIntroEl.hidden = false;
    stageIntroLabelEl.textContent = `Etapas ${screen.number} / ${screen.count}`;
    stageIntroNameEl.textContent = screen.name;
  } else if (screen.type === 'question') {
    showQuestion(screen);
  } else {
    showStageAnswers(screen.stage, screen.shownOptions);
  }

  counterEl.textContent = `${current + 1} / ${screens.length}`;
  prevBtn.disabled = current === 0;
  nextBtn.disabled = current === screens.length - 1;
  window.scrollTo(0, 0);
}

function go(delta) {
  const next = current + delta;
  if (next < 0 || next >= screens.length) return;
  current = next;
  render();
}

// --- fullscreen: the question's picture, else its picture options ---

// Pending end of a close animation — cancelled if it's opened again first.
let closeTimer = null;

function isFullscreenOpen() {
  return !overlayEl.hidden && overlayEl.classList.contains('visible');
}

function syncFullscreenButton(open) {
  fullscreenBtn.classList.toggle('is-active', open);
  fullscreenBtn.setAttribute('aria-pressed', String(open));
  fullscreenBtn.title = open ? 'Uždaryti pilną ekraną (F)' : 'Per visą ekraną (F)';
}

function buildFullscreenContent(screen) {
  const imgSrc = resolveMedia(screen.question.img);
  if (imgSrc) {
    const bigImg = document.createElement('img');
    bigImg.src = imgSrc;
    bigImg.alt = '';
    return bigImg;
  }
  const grid = document.createElement('div');
  grid.className = 'fullscreen-grid';
  const { cols, rows } = pickGridSize(screen.options.length);
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--rows', rows);
  screen.options.forEach((opt, i) => {
    const cell = document.createElement('div');
    cell.className = 'fullscreen-grid-cell';
    const img = document.createElement('img');
    img.src = resolveMedia(opt.img);
    img.alt = '';
    cell.append(img, createOptionLetter(i));
    grid.appendChild(cell);
  });
  return grid;
}

function openFullscreen() {
  const screen = screens[current];
  if (fullscreenBtn.hidden || !screen || screen.type !== 'question') return;
  clearTimeout(closeTimer);
  overlayContentEl.innerHTML = '';
  overlayContentEl.appendChild(buildFullscreenContent(screen));
  overlayEl.hidden = false;
  requestAnimationFrame(() => overlayEl.classList.add('visible'));
  syncFullscreenButton(true);
}

// immediate: on moving to another screen, so it doesn't show through a
// fading picture of the previous question.
function closeFullscreen(immediate) {
  syncFullscreenButton(false);
  if (overlayEl.hidden) return;
  overlayEl.classList.remove('visible');
  clearTimeout(closeTimer);
  const finish = () => {
    overlayEl.hidden = true;
    overlayContentEl.innerHTML = '';
  };
  if (immediate) finish();
  else closeTimer = setTimeout(finish, 250);
}

function toggleFullscreen() {
  if (isFullscreenOpen()) closeFullscreen();
  else openFullscreen();
}

// --- music: one button, always the marked clip from "nuo" to "iki" ---

function syncAudioButton() {
  const playing = !audioEl.paused;
  audioBtn.textContent = playing ? 'II' : '▶';
  audioBtn.setAttribute('aria-label', playing ? 'Pauzė' : 'Groti');
  audioBtn.classList.toggle('is-playing', playing);
}

function toggleAudio() {
  if (audioBtn.hidden) return;
  if (!audioEl.paused) {
    audioEl.pause();
    clipPaused = true;
    return;
  }
  const inClip = !audioEl.ended && audioEl.currentTime >= clipStart &&
    (clipEnd == null || audioEl.currentTime < clipEnd);
  if (!clipPaused || !inClip) audioEl.currentTime = clipStart;
  clipPaused = false;
  audioEl.play().catch(() => {
    errorEl.textContent = 'Nepavyko paleisti muzikos';
    errorEl.hidden = false;
  });
}

function updateAudioProgress() {
  if (!audioEl.duration) return;
  const segEnd = clipEnd != null ? Math.min(clipEnd, audioEl.duration) : audioEl.duration;
  const total = Math.max(segEnd - clipStart, 0);
  const elapsed = Math.min(Math.max(audioEl.currentTime - clipStart, 0), total);
  audioProgressFill.style.width = (total > 0 ? (elapsed / total) * 100 : 0) + '%';
}

// Checked every frame (not on timeupdate, which only fires a few times a
// second) so playback stops right at the "iki" mark instead of overshooting.
function tick() {
  if (audioEl.paused) return;
  if (clipEnd != null && audioEl.currentTime >= clipEnd) {
    audioEl.currentTime = clipEnd;
    stopAudio();
  }
  updateAudioProgress();
  requestAnimationFrame(tick);
}

audioEl.addEventListener('play', () => {
  errorEl.hidden = true;
  syncAudioButton();
  requestAnimationFrame(tick);
});
audioEl.addEventListener('pause', () => {
  syncAudioButton();
  updateAudioProgress();
});
audioEl.addEventListener('ended', syncAudioButton);

prevBtn.addEventListener('click', () => go(-1));
nextBtn.addEventListener('click', () => go(1));
audioBtn.addEventListener('click', toggleAudio);
fullscreenBtn.addEventListener('click', toggleFullscreen);
overlayEl.addEventListener('click', () => closeFullscreen());
audioStopBtn.addEventListener('click', () => {
  stopAudio();
  if (audioEl.getAttribute('src')) audioEl.currentTime = clipStart;
  audioProgressFill.style.width = '0%';
});

document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
  else if (e.key === ' ') {
    // Space would otherwise also "click" whichever bar button has focus.
    e.preventDefault();
    toggleAudio();
  } else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === 'Escape' && isFullscreenOpen()) closeFullscreen();
  else return;
  e.preventDefault();
});

async function init() {
  const game = gameId ? QuizGameStorage.getGame(gameId) : null;
  if (!game) {
    errorEl.textContent = 'Žaidimas nerastas šios naršyklės atmintyje';
    errorEl.hidden = false;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }
  document.title = `Peržiūra - ${game.name}`;
  await QuizMediaPreview.load(game).catch(() => {});
  screens = buildScreens(game);
  render();
}

init();
