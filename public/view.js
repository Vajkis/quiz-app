const ROOM_ID = document.body.dataset.room;

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
const leaderboardEl = document.getElementById('leaderboard');

const overlayEl = document.getElementById('fullscreen-overlay');
const overlayContentEl = document.getElementById('fullscreen-content');

const audioEl = document.getElementById('view-audio');
const audioProgressWrap = document.getElementById('audio-progress-wrap');
const audioProgressFill = document.getElementById('audio-progress-fill');

// stage-answers can list several questions, each with its own audio — a
// small "▶" next to whichever one's track is currently playing shows which
// (each .now-playing-icon carries the resolved src it belongs to in its
// dataset, set when the review is built). Compared without the origin: the
// host sends its own page's absolute URL, and it may reach the server by a
// different address (localhost vs the network IP) than this screen does.
function srcPath(src) {
  if (!src) return '';
  const url = new URL(src, location.href);
  return url.pathname + url.search;
}
function updateNowPlayingIcons() {
  const playing = audioEl.paused ? '' : srcPath(audioEl.currentSrc);
  document.querySelectorAll('.now-playing-icon').forEach((icon) => {
    icon.hidden = !playing || srcPath(icon.dataset.audioSrc) !== playing;
  });
}
audioEl.addEventListener('play', updateNowPlayingIcons);
audioEl.addEventListener('pause', updateNowPlayingIcons);

// Whichever segment the host is currently playing — the whole track, or just
// the marked nuo/iki clip — set from the audio-state snapshots it sends.
// Drives how the progress bar below the question fills up.
let audioClipMode = false;
let audioClipStart = 0;
let audioClipEnd = null;

// Driven by this element's own playback clock, not by audio-state messages, so
// the bar fills in real time instead of jumping only when the host acts.
// requestAnimationFrame (one frame at a time, only while actually playing)
// gives a smooth sweep — timeupdate alone only fires a few times a second.
function updateAudioProgress() {
  if (!audioEl.duration) return;
  const segStart = audioClipMode ? audioClipStart : 0;
  const segEnd = audioClipMode && audioClipEnd != null ? audioClipEnd : audioEl.duration;
  const total = Math.max(segEnd - segStart, 0);
  const elapsed = Math.min(Math.max(audioEl.currentTime - segStart, 0), total);
  audioProgressFill.style.width = (total > 0 ? (elapsed / total) * 100 : 0) + '%';
}

function animateAudioProgress() {
  updateAudioProgress();
  if (!audioEl.paused) requestAnimationFrame(animateAudioProgress);
}

// Playback waiting for a new track's metadata. Only the latest state counts —
// a stale one left behind (e.g. a track that never loaded) would otherwise
// fire later, when some other track loads, and start it on its own.
let pendingPlayback = null;

function cancelPendingPlayback() {
  if (!pendingPlayback) return;
  audioEl.removeEventListener('loadedmetadata', pendingPlayback);
  pendingPlayback = null;
}

audioEl.addEventListener('play', animateAudioProgress);
audioEl.addEventListener('pause', updateAudioProgress);
audioEl.addEventListener('seeked', updateAudioProgress);

// A question's audio field can be a full URL or a raw local file path — the
// server streams local paths via /api/local-audio. Mirrors resolveAudioSrc in server.js.
function resolveAudioSrc(value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return value;
  return `/api/local-audio?path=${encodeURIComponent(value)}`;
}

// Which screen is up (e.g. 'question-2', 'stage-answers'). The server
// re-sends the current screen when this page reconnects, so a fullscreen
// image only closes when the host actually moves on — not on a Wi-Fi blip.
let currentScreenKey = null;

function hideAll(screenKey) {
  if (screenKey !== currentScreenKey) {
    currentScreenKey = screenKey;
    closeFullscreen();
  }
  gameIntroEl.hidden = true;
  gameRulesEl.hidden = true;
  stageIntroEl.hidden = true;
  questionAreaEl.hidden = true;
  stageReviewEl.hidden = true;
  leaderboardEl.hidden = true;
  cancelPendingPlayback();
  audioEl.pause();
}

// Pending end of a close animation — cancelled if something is opened
// again before it finishes, so it doesn't hide the new content.
let closeTimer = null;

function openFullscreen(contentEl) {
  clearTimeout(closeTimer);
  overlayContentEl.innerHTML = '';
  overlayContentEl.appendChild(contentEl);
  overlayEl.hidden = false;
  requestAnimationFrame(() => {
    overlayEl.classList.add('visible');
  });
}

function closeFullscreen() {
  if (overlayEl.hidden) return;
  overlayEl.classList.remove('visible');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    overlayEl.hidden = true;
    overlayContentEl.innerHTML = '';
  }, 250);
}

// How many columns/rows to lay n option images out in. A fixed, near-square
// layout rather than one derived from the window's shape — that made a wide
// window put 4 images in a single row instead of the expected 2x2.
// 2 -> 2x1, 3 -> 3x1, 4 -> 2x2, 5-6 -> 3x2, 7-9 -> 3x3, 10-12 -> 4x3.
function pickGridSize(n) {
  if (n <= 3) return { cols: Math.max(n, 1), rows: 1 };
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

// No click-to-close here on purpose — this screen has no interactivity beyond
// the one-time "enable sound" button; the host closes fullscreen remotely too
// (see the 'fullscreen-command' handler below).

const socket = io();

socket.on('connect', () => {
  socket.emit('join-room', { roomId: ROOM_ID });
});

// The host's − / +: every font size on this screen is multiplied by it
// (see v.text() in styles/_variables.scss) — only the text, not the gaps.
socket.on('text-scale', ({ scale }) => {
  document.documentElement.style.setProperty('--text-scale', scale / 100);
  fitRules();
});

socket.on('room-closed', () => {
  alert('Hostas uždarė kambarį.');
  window.location.href = '/view';
});

socket.on('question', (q) => {
  hideAll(`question-${q.index}`);
  questionAreaEl.hidden = false;
  // No text (a picture or song question): just which question it is.
  questionTextEl.textContent = q.question ? `${q.number}. ${q.question}` : `${q.number} klausimas`;

  audioEl.src = q.audio ? resolveAudioSrc(q.audio) : '';
  audioClipMode = false;
  audioClipStart = 0;
  audioClipEnd = null;
  audioProgressWrap.hidden = !q.audio;
  audioProgressFill.style.width = '0%';

  questionBoxEl.classList.toggle('has-image', !!q.img);
  if (q.img) {
    imageEl.src = q.img;
    imageWrapEl.hidden = false;
  } else {
    imageWrapEl.hidden = true;
  }

  optionsEl.className = 'options-list';
  optionsEl.innerHTML = '';

  showBonusQuestion(bonusQuestionEl, q.hasBonus, q.bonusQuestion);

  if (q.type === 'chain') {
    renderChainClues(optionsEl, q.clues, q.clueImgs || []);
    return;
  }

  if (q.type === 'hints') {
    renderHints(optionsEl, q, false);
    return;
  }

  // Typed-answer question: no options exist on this side at all (the server
  // never sends the answer), just a prompt telling teams to type it in.
  if (q.textAnswer) {
    const hint = document.createElement('div');
    hint.className = 'view-text-answer-hint';
    hint.textContent = typedAnswerPrompt(q.answerCount, q.ordered);
    optionsEl.appendChild(hint);
    return;
  }
  // With a picture among the options, every option gets a cell of the
  // picture grid — a text one too — badged with its letter.
  if (q.options.some((opt) => opt.img)) {
    renderGridCells(
      optionsEl,
      q.options.map((opt, i) => ({ img: opt.img, text: opt.text, label: optionLetter(i) }))
    );
    return;
  }
  q.options.forEach((opt) => {
    const div = document.createElement('div');
    div.className = 'view-option';
    div.textContent = opt.text;
    optionsEl.appendChild(div);
  });
});

// A chain: its clues, numbered like the fields teams type each answer in.
// With a picture among them every clue gets a cell of the picture grid,
// badged with its number (1, 2, 3… where options have A, B, C…).
function renderChainClues(container, clues, imgs) {
  if (imgs.some(Boolean)) {
    renderGridCells(
      container,
      clues.map((clue, i) => ({ img: imgs[i], text: clue, label: String(i + 1) }))
    );
    return;
  }
  clues.forEach((clue, i) => {
    const div = document.createElement('div');
    div.className = 'view-option view-chain-clue';
    const number = document.createElement('span');
    number.className = 'chain-clue-number';
    number.textContent = `${i + 1}.`;
    div.append(number, document.createTextNode(clue));
    container.appendChild(div);
  });
}

// A hints question: the hints shown so far (the server never sends one
// before the host reveals it), numbered — a newly revealed one (animate)
// fades in — and under them the same "type your answer" note as a
// typed-answer question.
function renderHints(container, { hints }, animate) {
  container.className = 'options-list';
  container.innerHTML = '';
  hints.forEach((hint, i) => {
    const div = document.createElement('div');
    div.className = 'view-option view-chain-clue';
    if (animate && i === hints.length - 1) div.classList.add('is-new-hint');
    const number = document.createElement('span');
    number.className = 'chain-clue-number';
    number.textContent = `${i + 1}.`;
    div.append(number, document.createTextNode(hint));
    container.appendChild(div);
  });
  const note = document.createElement('div');
  note.className = 'view-text-answer-hint';
  note.textContent = 'Įrašykite atsakymą';
  container.appendChild(note);
}

// The host revealed the next hint of the question on screen.
socket.on('hints', (progress) => {
  if (currentScreenKey !== `question-${progress.index}`) return;
  renderHints(optionsEl, progress, true);
});

// Picture options (or clues) fill all the space left under the question,
// laid out the same way as the fullscreen grid (2x2 for 4, etc.).
function renderGridCells(container, cells) {
  container.className = 'options-grid image-options';
  const { cols, rows } = pickGridSize(cells.length);
  container.style.setProperty('--cols', cols);
  container.style.setProperty('--rows', rows);
  cells.forEach((cell) => container.appendChild(createGridCell('view-option', cell)));
}

// One cell of a picture grid: the picture, or a text option or clue among
// pictures, with its letter or number badge on top.
function createGridCell(className, { img, text, label }) {
  const div = document.createElement('div');
  div.className = className;
  if (img) {
    const imgEl = document.createElement('img');
    imgEl.src = img;
    imgEl.alt = '';
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

// Under the question text, in its box: the extra answer's question (e.g.
// "Atlikėjas"), which teams type in their own field on their phones.
function showBonusQuestion(el, hasBonus, question) {
  el.hidden = !hasBonus;
  el.textContent = question ? `Papildomas klausimas: ${question}` : 'Papildomas atsakymas';
}

// The extra answer after the main one, in the extra question's purple
// (see #view-bonus-question), so the two can't be mistaken for one answer.
function appendBonusAnswer(answerP, bonusAnswer) {
  const span = document.createElement('span');
  span.className = 'bonus-answer-text';
  span.innerHTML = ` ${QuizIcons.icon('plus')} `;
  span.append(bonusAnswer);
  answerP.appendChild(span);
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
// fits without scrolling. Re-fitted when the window resizes or the font loads.
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

// Every picture on this screen (question, options, fullscreen) gets an
// empty alt on purpose: no question or option text ever rides along with
// one, where it could give an answer away.

// Letter badge on a picture grid's option — players' phones only get this
// letter for a picture (never the picture), so it has to match their A, B,
// C… order exactly. A chain's clue gets its number instead.
function optionLetter(index) {
  return String.fromCharCode(65 + index);
}

function createOptionBadge(label) {
  const badge = document.createElement('span');
  badge.className = 'option-letter';
  badge.textContent = label;
  return badge;
}

// The host sends the actual image URL(s) with the command — this also has to
// work for an image the host is showing from the stage-answers review, which
// this screen never rendered itself, so there's no local DOM to reuse.
socket.on('fullscreen-command', ({ action, src, images }) => {
  if (action === 'image') {
    if (!src) return;
    const bigImg = document.createElement('img');
    bigImg.src = src;
    bigImg.alt = '';
    openFullscreen(bigImg);
  } else if (action === 'options') {
    const grid = document.createElement('div');
    grid.className = 'fullscreen-grid';
    const list = images || [];
    const { cols, rows } = pickGridSize(list.length);
    grid.style.setProperty('--cols', cols);
    grid.style.setProperty('--rows', rows);
    list.forEach((opt, i) => {
      grid.appendChild(
        createGridCell('fullscreen-grid-cell', {
          img: opt.src,
          text: opt.text,
          label: opt.label || optionLetter(i)
        })
      );
    });
    openFullscreen(grid);
  } else if (action === 'close') {
    closeFullscreen();
  }
});

// The host's <audio> element (muted, for its own scrubber/time/volume display)
// drives this directly — just mirror whatever state it reports. It also names
// its own src: host/stage-answers.ejs can have several audio blocks (one per
// question in the stage), so this may need to swap tracks, not just seek —
// the currently-shown question's audio alone isn't necessarily the right one.
socket.on('audio-state', ({ src, paused, time, volume, clipMode, clipStart, clipEnd }) => {
  audioClipMode = !!clipMode;
  audioClipStart = clipStart || 0;
  audioClipEnd = clipEnd != null ? clipEnd : null;

  if (typeof volume === 'number') audioEl.volume = volume;

  function applyPlayback() {
    if (typeof time === 'number' && Math.abs(audioEl.currentTime - time) > 0.75) {
      audioEl.currentTime = time;
    }
    if (paused) {
      audioEl.pause();
    } else {
      audioEl.play().catch(() => {});
    }
  }

  cancelPendingPlayback();

  const absSrc = src ? new URL(src, location.href).href : '';
  if (absSrc && audioEl.currentSrc !== absSrc) {
    pendingPlayback = () => {
      pendingPlayback = null;
      applyPlayback();
    };
    audioEl.addEventListener('loadedmetadata', pendingPlayback, { once: true });
    audioEl.src = absSrc;
  } else {
    applyPlayback();
  }
});

socket.on('game-intro', ({ gameName }) => {
  hideAll('game-intro');
  gameIntroEl.hidden = false;
  gameIntroNameEl.textContent = gameName;
});

socket.on('game-rules', ({ rules }) => {
  hideAll('game-rules');
  gameRulesEl.hidden = false;
  renderRules(rules || []);
});

socket.on('stage-intro', ({ stageName, stageTopic, stageDescription, stageNumber, stageCount }) => {
  hideAll(`stage-intro-${stageNumber}`);
  stageIntroEl.hidden = false;
  stageIntroLabelEl.textContent = `Etapas ${stageNumber} / ${stageCount}`;
  stageIntroNameEl.textContent = stageName;
  stageIntroTopicEl.textContent = stageTopic || '';
  stageIntroTopicEl.hidden = !stageTopic;
  stageIntroDescriptionEl.textContent = stageDescription || '';
  stageIntroDescriptionEl.hidden = !stageDescription;
});

socket.on('stage-answers', (review) => {
  hideAll('stage-answers');
  stageReviewEl.hidden = false;
  stageReviewEl.innerHTML = '';

  const title = document.createElement('p');
  title.className = 'leaderboard-title';
  title.textContent = `Teisingi atsakymai: ${review.stageName}`;
  stageReviewEl.appendChild(title);

  review.questions.forEach((q) => {
    const box = document.createElement('div');
    box.className = 'question';

    const questionP = document.createElement('p');
    questionP.textContent = `${q.number}. ${q.question}`;

    const answerP = document.createElement('p');
    answerP.className = 'correct-answer';
    answerP.textContent = q.correctAnswer;
    if (q.bonus) appendBonusAnswer(answerP, q.bonus.answer);

    box.append(questionP, answerP);

    if (q.audio) {
      const icon = document.createElement('span');
      icon.className = 'now-playing-icon';
      icon.innerHTML = QuizIcons.icon('play');
      icon.hidden = true;
      icon.dataset.audioSrc = resolveAudioSrc(q.audio);
      box.appendChild(icon);
    }

    stageReviewEl.appendChild(box);
  });

  updateNowPlayingIcons();
});

socket.on('leaderboard', ({ rows, final, stageName, seasonId, penalties }) => {
  hideAll(`leaderboard-${final ? 'final' : stageName}-${seasonId || ''}-${penalties ? 'penalties' : ''}`);
  leaderboardEl.hidden = false;
  leaderboardEl.innerHTML = '';

  const title = document.createElement('p');
  title.className = 'leaderboard-title';
  title.textContent = penalties
    ? 'Nuobaudos taškai'
    : seasonId
      ? 'Sezono rezultatai'
      : final
        ? 'Galutiniai rezultatai'
        : `Rezultatai po etapo: ${stageName}`;
  leaderboardEl.appendChild(title);

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = penalties
      ? 'Nė viena komanda negavo nuobaudos taškų.'
      : 'Nė viena komanda neatsakė į klausimus.';
    leaderboardEl.appendChild(empty);
    return;
  }

  rows.forEach((row, i) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'leaderboard-row';

    const rank = document.createElement('span');
    rank.className = 'leaderboard-rank';
    rank.textContent = `${i + 1}.`;

    const name = document.createElement('span');
    name.className = 'leaderboard-name';
    name.textContent = row.name;

    const score = document.createElement('span');
    score.className = 'leaderboard-score';
    score.textContent = row.score;

    rowEl.append(rank, name, score);
    leaderboardEl.appendChild(rowEl);
  });
});
