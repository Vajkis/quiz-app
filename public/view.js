const ROOM_ID = document.body.dataset.room;

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
  stageIntroEl.hidden = true;
  questionAreaEl.hidden = true;
  stageReviewEl.hidden = true;
  leaderboardEl.hidden = true;
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

socket.on('room-closed', () => {
  alert('Hostas uždarė kambarį.');
  window.location.href = '/view';
});

socket.on('question', (q) => {
  hideAll(`question-${q.index}`);
  questionAreaEl.hidden = false;
  questionTextEl.textContent = `${q.number}. ${q.question}`;

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

  const optionsAreImages = q.options.length > 0 && q.options.every((opt) => opt.img);
  optionsEl.className = optionsAreImages ? 'options-grid image-options' : 'options-list';
  optionsEl.innerHTML = '';
  // Image options fill all the space left under the question, laid out the
  // same way as the fullscreen grid (2x2 for 4, etc.).
  if (optionsAreImages) {
    const { cols, rows } = pickGridSize(q.options.length);
    optionsEl.style.setProperty('--cols', cols);
    optionsEl.style.setProperty('--rows', rows);
  }

  // Typed-answer question: no options exist on this side at all (the server
  // never sends the answer), just a prompt telling teams to type it in.
  if (q.textAnswer) {
    const hint = document.createElement('div');
    hint.className = 'view-text-answer-hint';
    hint.textContent = 'Įrašykite atsakymą';
    optionsEl.appendChild(hint);
    return;
  }
  q.options.forEach((opt, i) => {
    const div = document.createElement('div');
    div.className = 'view-option';
    if (opt.img) {
      const imgEl = document.createElement('img');
      imgEl.src = opt.img;
      imgEl.alt = '';
      div.appendChild(imgEl);
      div.appendChild(createOptionLetter(i));
    } else {
      div.textContent = opt.text;
    }
    optionsEl.appendChild(div);
  });
});

// Every picture on this screen (question, options, fullscreen) gets an
// empty alt on purpose: no question or option text ever rides along with
// one, where it could give an answer away.

// Letter badge on a picture option — players' phones only get this letter
// (never the picture), so it has to match their A, B, C… order exactly.
function createOptionLetter(index) {
  const badge = document.createElement('span');
  badge.className = 'option-letter';
  badge.textContent = String.fromCharCode(65 + index);
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
      const cell = document.createElement('div');
      cell.className = 'fullscreen-grid-cell';
      const img = document.createElement('img');
      img.src = opt.src;
      img.alt = '';
      cell.append(img, createOptionLetter(i));
      grid.appendChild(cell);
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

  if (src && audioEl.currentSrc !== src) {
    audioEl.src = src;
    audioEl.addEventListener('loadedmetadata', applyPlayback, { once: true });
  } else {
    applyPlayback();
  }
});

socket.on('game-intro', ({ gameName }) => {
  hideAll('game-intro');
  gameIntroEl.hidden = false;
  gameIntroNameEl.textContent = gameName;
});

socket.on('stage-intro', ({ stageName, stageNumber, stageCount }) => {
  hideAll(`stage-intro-${stageNumber}`);
  stageIntroEl.hidden = false;
  stageIntroLabelEl.textContent = `Etapas ${stageNumber} / ${stageCount}`;
  stageIntroNameEl.textContent = stageName;
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

    box.append(questionP, answerP);

    if (q.audio) {
      const icon = document.createElement('span');
      icon.className = 'now-playing-icon';
      icon.textContent = '▶';
      icon.hidden = true;
      icon.dataset.audioSrc = resolveAudioSrc(q.audio);
      box.appendChild(icon);
    }

    stageReviewEl.appendChild(box);
  });

  updateNowPlayingIcons();
});

socket.on('leaderboard', ({ rows, final, stageName, seasonId }) => {
  hideAll(`leaderboard-${final ? 'final' : stageName}-${seasonId || ''}`);
  leaderboardEl.hidden = false;
  leaderboardEl.innerHTML = '';

  const title = document.createElement('p');
  title.className = 'leaderboard-title';
  title.textContent = seasonId
    ? 'Sezono rezultatai'
    : final
      ? 'Galutiniai rezultatai'
      : `Rezultatai po etapo: ${stageName}`;
  leaderboardEl.appendChild(title);

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Nė viena komanda neatsakė į klausimus.';
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
