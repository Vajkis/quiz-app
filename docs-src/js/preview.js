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
const gameRulesEl = document.getElementById('game-rules-screen');
const gameRulesListEl = document.getElementById('game-rules-list');

const stageIntroEl = document.getElementById('stage-intro-screen');
const stageIntroLabelEl = document.getElementById('stage-intro-label');
const stageIntroNameEl = document.getElementById('stage-intro-name');
const stageIntroTopicEl = document.getElementById('stage-intro-topic');
const stageIntroDescriptionEl = document.getElementById('stage-intro-description');

const questionAreaEl = document.getElementById('view-question');
const questionBoxEl = document.getElementById('view-question-box');
const imageWrapEl = document.getElementById('view-image-wrap');
const imageEl = document.getElementById('view-image');
const questionTextEl = document.getElementById('view-question-text');
const optionsEl = document.getElementById('view-options');
const bonusQuestionEl = document.getElementById('view-bonus-question');
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

function createOptionBadge(label) {
  const badge = document.createElement('span');
  badge.className = 'option-letter';
  badge.textContent = label;
  return badge;
}

// With a picture among a question's options (or a chain's clues), every one
// of them is a cell of the picture grid — a text one too — badged with its
// letter (A, B, C…) or, for a clue, its number (1, 2, 3…), like view.js
// does. Empty when there's no picture among them.
function gridCellsFor(screen) {
  if (screen.questionType === 'chain') {
    const links = screen.question.links;
    if (!links.some((l) => l.img)) return [];
    return links.map((l, i) => ({ img: resolveMedia(l.img), text: l.clue, label: String(i + 1) }));
  }
  if (!screen.options.some((opt) => opt.img)) return [];
  return screen.options.map((opt, i) => ({
    img: resolveMedia(opt.img),
    text: opt.text,
    label: String.fromCharCode(65 + i),
  }));
}

// One cell of a picture grid: the picture, or a text option or clue among
// pictures, with its letter or number badge on top.
function createGridCell(className, { img, text, label }) {
  const div = document.createElement('div');
  div.className = className;
  if (img) {
    const imgEl = document.createElement('img');
    imgEl.src = img;
    imgEl.alt = ''; // never any text — it could give the answer away
    div.appendChild(imgEl);
  } else {
    div.classList.add('grid-text-cell');
    const span = document.createElement('span');
    span.className = 'grid-cell-text';
    span.textContent = text || '';
    div.appendChild(span);
  }
  div.appendChild(createOptionBadge(label));
  return div;
}

// The first option is the correct one in a stored game (see
// normalizeGamePayload), so a choice question's options are shuffled —
// once, when the preview opens, so going back and forth doesn't reorder
// them — as the server does. Taip / Ne always keep their order.
const YES_NO_OPTIONS = [{ text: 'Taip' }, { text: 'Ne' }];
function shownOptionsFor(q) {
  const type = QuizGameShared.questionType(q);
  if (type === 'choice') return shuffle(q.options);
  if (type === 'yesno') return YES_NO_OPTIONS;
  return [];
}

// What a question is called on screen — a chain or a hints question needs
// no text of its own (like questionTitle in server.js).
function questionTitle(q) {
  if (q.question) return q.question;
  if (q.type === 'chain') return 'Grandinėlė';
  if (q.type === 'hints') return 'Užuominos';
  return '';
}

// What a typed-answer question asks for: one answer, or how many to list
// (and whether in order) — 21 "atsakymą", 2–9 "atsakymus", 10–20 or
// ending in 0 "atsakymų".
function typedAnswerPrompt(count, ordered) {
  if (!count || count < 2) return 'Įrašykite atsakymą';
  const n = count % 100;
  const word =
    n % 10 === 0 || (n >= 10 && n <= 20) ? 'atsakymų' : n % 10 === 1 ? 'atsakymą' : 'atsakymus';
  return `Įrašykite ${count} ${word}${ordered ? ' eilės tvarka' : ''}`;
}

function buildScreens(game) {
  const list = [{ type: 'game-intro', name: game.name }];
  if (game.rules && game.rules.length) list.push({ type: 'game-rules', rules: game.rules });
  game.stages.forEach((stage, s) => {
    list.push({
      type: 'stage-intro',
      name: stage.name,
      topic: stage.topic || '',
      description: stage.description || '',
      number: s + 1,
      count: game.stages.length,
    });
    const shownOptions = stage.questions.map(shownOptionsFor);
    stage.questions.forEach((q, i) => {
      const questionType = QuizGameShared.questionType(q);
      // A hints question gets a screen per hint, as the host reveals them
      // one by one.
      const steps = questionType === 'hints' ? q.hints.length : 1;
      for (let revealed = 1; revealed <= steps; revealed++) {
        list.push({
          type: 'question',
          number: i + 1,
          question: q,
          questionType,
          options: shownOptions[i],
          revealedHints: revealed,
        });
      }
    });
    list.push({ type: 'stage-answers', stage, shownOptions });
  });
  return list;
}

// The game's rules, one list item each — the slide after its name.
function renderRules(rules) {
  gameRulesListEl.innerHTML = '';
  rules.forEach((rule) => {
    const li = document.createElement('li');
    li.textContent = rule;
    gameRulesListEl.appendChild(li);
  });
  fitRules();
}

// When there are too many rules for the screen, their text shrinks (from the
// stylesheet's size down to RULES_MIN_FONT_PX at most) until the whole slide
// fits above the bar without scrolling. Re-fitted when the window resizes or
// the font loads.
const RULES_MIN_FONT_PX = 14;
function fitRules() {
  if (gameRulesEl.hidden) return;
  const fits = () => document.documentElement.scrollHeight <= window.innerHeight;
  gameRulesListEl.style.fontSize = '';
  if (fits()) return;
  let lo = RULES_MIN_FONT_PX;
  let hi = parseFloat(getComputedStyle(gameRulesListEl).fontSize);
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    gameRulesListEl.style.fontSize = `${mid}px`;
    if (fits()) lo = mid;
    else hi = mid;
  }
  gameRulesListEl.style.fontSize = `${lo}px`;
}
window.addEventListener('resize', fitRules);
// A font finishing loading (Mulish, usually after the first fit on a fresh
// load — fonts.ready would already have resolved by then) changes the size.
document.fonts.addEventListener('loadingdone', fitRules);

function stopAudio() {
  clipPaused = false;
  audioEl.pause();
  syncAudioButton();
}

function hideAll() {
  gameIntroEl.hidden = true;
  gameRulesEl.hidden = true;
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
  // No text (a picture or song question): just which question it is.
  const title = questionTitle(q);
  questionTextEl.textContent = title ? `${screen.number}. ${title}` : `${screen.number} klausimas`;

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

  const cells = gridCellsFor(screen);
  fullscreenBtn.hidden = !imgSrc && !cells.length;
  optionsEl.className = 'options-list';
  optionsEl.innerHTML = '';

  bonusQuestionEl.hidden = !q.bonus;
  bonusQuestionEl.textContent =
    q.bonus && q.bonus.question ? `Papildomas klausimas: ${q.bonus.question}` : 'Papildomas atsakymas';

  // Picture options (or clues) fill all the space left under the question,
  // laid out the same way as the fullscreen grid (2x2 for 4, etc.).
  if (cells.length) {
    optionsEl.className = 'options-grid image-options';
    const { cols, rows } = pickGridSize(cells.length);
    optionsEl.style.setProperty('--cols', cols);
    optionsEl.style.setProperty('--rows', rows);
    cells.forEach((cell) => optionsEl.appendChild(createGridCell('view-option', cell)));
    return;
  }

  // A hints question: the hints shown so far, and the same "type your
  // answer" note as a typed-answer question (see renderHints in view.js).
  if (screen.questionType === 'hints') {
    const shown = q.hints.slice(0, screen.revealedHints);
    shown.forEach((hint, i) => {
      const div = document.createElement('div');
      div.className = 'view-option view-chain-clue';
      if (i === shown.length - 1 && i > 0) div.classList.add('is-new-hint');
      const number = document.createElement('span');
      number.className = 'chain-clue-number';
      number.textContent = `${i + 1}.`;
      div.append(number, document.createTextNode(hint));
      optionsEl.appendChild(div);
    });
    const note = document.createElement('div');
    note.className = 'view-text-answer-hint';
    note.textContent = 'Įrašykite atsakymą';
    optionsEl.appendChild(note);
    return;
  }

  // A chain: its clues, numbered like the fields teams type each answer in.
  if (screen.questionType === 'chain') {
    q.links.forEach((link, i) => {
      const div = document.createElement('div');
      div.className = 'view-option view-chain-clue';
      const number = document.createElement('span');
      number.className = 'chain-clue-number';
      number.textContent = `${i + 1}.`;
      div.append(number, document.createTextNode(link.clue));
      optionsEl.appendChild(div);
    });
    return;
  }

  if (screen.questionType === 'text') {
    const hint = document.createElement('div');
    hint.className = 'view-text-answer-hint';
    hint.textContent = typedAnswerPrompt(q.options.length, q.ordered);
    optionsEl.appendChild(hint);
    return;
  }
  screen.options.forEach((opt) => {
    const div = document.createElement('div');
    div.className = 'view-option';
    div.textContent = opt.text;
    optionsEl.appendChild(div);
  });
}

// The correct option is the first one in a stored game; a picture option is
// named by the letter it had on its question's screen, like buildStageReview
// in server.js does.
function correctAnswerText(q, shown) {
  const type = QuizGameShared.questionType(q);
  if (type === 'chain') return q.links.map((l) => l.answer).join(' → ');
  if (type === 'yesno') return q.answer === 'yes' ? 'Taip' : 'Ne';
  if (type === 'hints') return q.answer;
  if (type === 'text') return q.options.map((o) => o.text).join(q.ordered ? ' → ' : ', ');
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
    questionP.textContent = `${i + 1}. ${questionTitle(q)}`;
    const answerP = document.createElement('p');
    answerP.className = 'correct-answer';
    const answer = correctAnswerText(q, shownOptions[i]);
    answerP.textContent = answer;
    // The extra answer in the extra question's purple (see view.scss).
    if (q.bonus) {
      const bonusSpan = document.createElement('span');
      bonusSpan.className = 'bonus-answer-text';
      bonusSpan.textContent = ` + ${q.bonus.answer}`;
      answerP.appendChild(bonusSpan);
    }
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
  } else if (screen.type === 'game-rules') {
    gameRulesEl.hidden = false;
    renderRules(screen.rules);
  } else if (screen.type === 'stage-intro') {
    stageIntroEl.hidden = false;
    stageIntroLabelEl.textContent = `Etapas ${screen.number} / ${screen.count}`;
    stageIntroNameEl.textContent = screen.name;
    stageIntroTopicEl.textContent = screen.topic;
    stageIntroTopicEl.hidden = !screen.topic;
    stageIntroDescriptionEl.textContent = screen.description;
    stageIntroDescriptionEl.hidden = !screen.description;
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
  const cells = gridCellsFor(screen);
  const grid = document.createElement('div');
  grid.className = 'fullscreen-grid';
  const { cols, rows } = pickGridSize(cells.length);
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--rows', rows);
  cells.forEach((cell) => grid.appendChild(createGridCell('fullscreen-grid-cell', cell)));
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
  // The game's background picture, behind every screen (see view.scss).
  const background = resolveMedia(game.background);
  if (background) {
    document.body.classList.add('has-game-bg');
    document.body.style.setProperty('--game-bg', `url(${JSON.stringify(background)})`);
  }
  screens = buildScreens(game);
  render();
}

init();
