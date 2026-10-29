// Dashboard: create room form
const newRoomBtn = document.getElementById('new-room-btn');
if (newRoomBtn) {
  const gameSelect = document.getElementById('game-select');
  const errorEl = document.getElementById('create-room-error');

  newRoomBtn.addEventListener('click', async () => {
    errorEl.textContent = '';

    const res = await fetch('/api/host/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: gameSelect.value }),
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Nepavyko sukurti kambario';
      return;
    }

    window.location.href = '/host/' + data.roomId;
  });
}

// Dashboard: active season, set once and reused for every room created
// afterwards (see /api/host/room) instead of being typed in per game.
const saveSeasonBtn = document.getElementById('save-season-btn');
if (saveSeasonBtn) {
  const seasonEditInput = document.getElementById('season-edit-input');
  const seasonErrorEl = document.getElementById('season-error');

  saveSeasonBtn.addEventListener('click', async () => {
    seasonErrorEl.textContent = '';
    const res = await fetch('/api/host/season', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ season: seasonEditInput.value }),
    });
    const data = await res.json();

    if (!res.ok) {
      seasonErrorEl.textContent = data.error || 'Nepavyko išsaugoti sezono';
      return;
    }

    seasonEditInput.value = data.activeSeason || '';
  });

  // Changed elsewhere — the side panel's season button, or another tab
  // (the panel notices within a few seconds): the field follows, unless
  // it's being typed into right now.
  document.addEventListener('seasonchange', (e) => {
    if (document.activeElement === seasonEditInput) return;
    seasonEditInput.value = e.detail || '';
  });
}

// Dashboard: close room
document.querySelectorAll('.room-close-btn').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const res = await fetch(`/api/host/room/${btn.dataset.id}`, { method: 'DELETE' });
    if (!res.ok) return;
    btn.closest('.room-row').remove();
  });
});

// Room panel + stage-answers review: one shared socket for every remote
// command this page sends (audio playback state, fullscreen triggers) — a
// stage-answers page can have several audio blocks, and they should all ride
// the same connection rather than opening one each.
let hostSocket = null;
function getHostSocket() {
  if (!hostSocket) hostSocket = io();
  return hostSocket;
}

// Room pages: every control is handled from the page as a whole rather than
// wired to its own element — a refresh (refreshRoom) brings new ones in
// place of the old, and these keep working on them.
function onClick(selector, handler) {
  document.addEventListener('click', (e) => {
    const el = e.target.closest(selector);
    if (el && !el.disabled) handler(el, e);
  });
}

// Each .audio-player-block holds a muted <audio> — muted because it's only
// here so the host can see and drive playback (its controls from
// audio-player.js: bar, elapsed time, volume); the actual sound comes from the view screen's own (unmuted)
// element, which mirrors every play/pause/seek/volume change as a state
// snapshot. There can be more than one block on a page (stage-answers lists
// every question in the stage), so this is wired per block, not by fixed id
// — once each, on arrival and for every block a refresh brings — and each
// keeps its controls in block.quizAudio, for the bottom bar's ▶ / ■.
function pauseOtherAudioBlocks(except) {
  document.querySelectorAll('.question-audio').forEach((a) => {
    if (a !== except && !a.paused) a.pause();
  });
}

function initAudioBlock(block) {
  const questionAudio = block.querySelector('.question-audio');
  if (!questionAudio || block.quizAudio) return;
  questionAudio.muted = true;
  const roomId = block.dataset.room;
  const clipStart = Number(questionAudio.dataset.start) || 0;
  const clipEnd = questionAudio.dataset.end ? Number(questionAudio.dataset.end) : null;
  let clipModeActive = false;
  let clipEndReached = false; // only auto-pause once per pass — otherwise a manual
  // play from the native controls right after would just get paused again instantly

  // currentSrc is absolute with this page's origin — e.g. http://localhost:3000/...
  // when the host runs on the server's own machine, which a view screen on
  // another device can't reach. Send same-origin files as a path instead.
  function audioSrcForView() {
    const url = new URL(questionAudio.currentSrc || questionAudio.src, location.href);
    return url.origin === location.origin ? url.pathname + url.search : url.href;
  }

  function sendAudioState() {
    // Not once a refresh has taken the block off the page (which pauses it):
    // the view screen has moved on with the host, and would load it again.
    if (!block.isConnected) return;
    getHostSocket().emit('audio-state', {
      roomId,
      src: audioSrcForView(),
      paused: questionAudio.paused,
      time: questionAudio.currentTime,
      volume: questionAudio.volume,
      clipMode: clipModeActive,
      clipStart,
      clipEnd,
    });
  }

  ['play', 'pause', 'seeked', 'volumechange'].forEach((evt) => {
    questionAudio.addEventListener(evt, sendAudioState);
  });

  if (clipEnd != null) {
    questionAudio.addEventListener('timeupdate', () => {
      if (!clipModeActive) return;
      if (questionAudio.currentTime < clipEnd) {
        clipEndReached = false; // rewound before the mark — re-arm the auto-stop
        return;
      }
      if (clipEndReached) return; // already handled this pass; let manual play continue freely
      clipEndReached = true;
      questionAudio.pause();
      questionAudio.currentTime = clipEnd; // snap exactly to the mark, don't overshoot
      // clipModeActive stays true: the progress bar keeps reading position against
      // the clip's own start/end, so it holds at 100% instead of snapping back to 0.
    });
  }

  // A recording that still hasn't loaded (see keepLoading in
  // audio-player.js) is asked for once more by playing it.
  function loadIfFailed() {
    if (questionAudio.error && questionAudio.quizKeepLoading) questionAudio.quizKeepLoading.retry();
  }

  function playClip() {
    loadIfFailed();
    pauseOtherAudioBlocks(questionAudio);
    clipModeActive = true;
    clipEndReached = false;
    questionAudio.currentTime = clipStart;
    questionAudio.play();
  }

  function playNormal() {
    loadIfFailed();
    pauseOtherAudioBlocks(questionAudio);
    clipModeActive = false;
    questionAudio.currentTime = 0;
    questionAudio.play();
  }

  const playClipBtn = block.querySelector('.play-audio-clip-btn');
  if (playClipBtn) playClipBtn.addEventListener('click', playClip);

  const playNormalBtn = block.querySelector('.play-audio-normal-btn');
  if (playNormalBtn) playNormalBtn.addEventListener('click', playNormal);

  // Bottom bar (room page — one question, so at most one block): ▶ starts
  // the marked part if there is one (else the whole track) or resumes after
  // II; ■ stops and rewinds, so the next ▶ starts over.
  const hasClip = !!playClipBtn;
  let stopped = true; // next ▶ starts over rather than resuming

  function syncBarButton() {
    const barPlayBtn = document.getElementById('host-bar-audio');
    if (!barPlayBtn) return;
    const playing = !questionAudio.paused;
    barPlayBtn.innerHTML = QuizIcons.icon(playing ? 'pause' : 'play');
    barPlayBtn.setAttribute('aria-label', playing ? 'Pauzė' : 'Groti');
    barPlayBtn.classList.toggle('is-playing', playing);
  }

  questionAudio.addEventListener('play', () => {
    stopped = false;
    syncBarButton();
  });
  questionAudio.addEventListener('pause', () => {
    // paused by the clip's own "iki" mark — that's the end, not a pause
    if (clipModeActive && clipEndReached) stopped = true;
    syncBarButton();
  });
  questionAudio.addEventListener('ended', () => {
    stopped = true;
    syncBarButton();
  });

  block.quizAudio = {
    syncBarButton,
    play() {
      if (!questionAudio.paused) {
        questionAudio.pause();
      } else if (stopped) {
        if (hasClip) playClip();
        else playNormal();
      } else {
        loadIfFailed();
        questionAudio.play();
      }
    },
    stop() {
      stopped = true;
      questionAudio.pause();
      questionAudio.currentTime = clipModeActive ? clipStart : 0;
    },
  };
}

function initAudioBlocks() {
  document.querySelectorAll('.audio-player-block').forEach(initAudioBlock);
}
initAudioBlocks();

// The bottom bar's ▶ / ■ drive the page's one block (a room page has at most one).
function barAudio() {
  const blocks = document.querySelectorAll('.audio-player-block');
  return blocks.length === 1 ? blocks[0].quizAudio : null;
}
onClick('#host-bar-audio', () => {
  const audio = barAudio();
  if (audio) audio.play();
});
onClick('#host-bar-audio-stop', () => {
  const audio = barAudio();
  if (audio) audio.stop();
});

// Room panel + stage-answers review: remotely trigger (or dismiss) the view
// screen's fullscreen image display — the view screen has no clickable
// controls of its own for this, it just reacts to whatever the host sends.
// The actual image URL(s) travel with the command, since a stage-answers
// block isn't showing the live question view has loaded.
function sendFullscreenCommand(roomId, payload) {
  getHostSocket().emit('fullscreen-command', { roomId, ...payload });
  setBarFullscreenState(payload);
}

function parseImagesAttr(value) {
  try {
    return JSON.parse(value) || [];
  } catch (err) {
    return [];
  }
}

// Room panel bottom bar: a button that opens the question's picture (or,
// without one, or with a hidden one, its picture options) on the view
// screen, and closes it again — and with a hidden picture, one more for
// that. They only know what this page sent — the view screen closes it by
// itself when the host moves on, and moving on brings them back closed.
const BAR_FULLSCREEN_TITLES = {
  'host-bar-fullscreen': 'Per visą ekraną (žiūrovų ekrane)',
  'host-bar-hidden-img': 'Paslėptą nuotrauką per visą ekraną (Shift+F)'
};
function setBarFullscreenState(payload) {
  const hiddenBtn = document.getElementById('host-bar-hidden-img');
  const showsHidden =
    !!hiddenBtn && payload.action === 'image' && payload.src === hiddenBtn.dataset.src;
  Object.keys(BAR_FULLSCREEN_TITLES).forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const open =
      payload.action !== 'close' && (id === 'host-bar-hidden-img') === showsHidden;
    btn.classList.toggle('is-active', open);
    btn.setAttribute('aria-pressed', String(open));
    btn.title = open ? 'Uždaryti pilną ekraną' : BAR_FULLSCREEN_TITLES[id];
  });
}

onClick('#host-bar-fullscreen, #host-bar-hidden-img', (btn) => {
  const roomId = btn.dataset.room;
  if (btn.getAttribute('aria-pressed') === 'true') {
    sendFullscreenCommand(roomId, { action: 'close' });
  } else if (btn.dataset.src) {
    sendFullscreenCommand(roomId, { action: 'image', src: btn.dataset.src });
  } else {
    sendFullscreenCommand(roomId, { action: 'options', images: parseImagesAttr(btn.dataset.images) });
  }
});

const fullscreenRoom = (btn) => btn.closest('.fullscreen-mode-buttons').dataset.room;
onClick('.fullscreen-image-btn', (btn) => {
  sendFullscreenCommand(fullscreenRoom(btn), { action: 'image', src: btn.dataset.src });
});
onClick('.fullscreen-options-btn', (btn) => {
  sendFullscreenCommand(fullscreenRoom(btn), { action: 'options', images: parseImagesAttr(btn.dataset.images) });
});
onClick('.fullscreen-close-btn', (btn) => {
  sendFullscreenCommand(fullscreenRoom(btn), { action: 'close' });
});

// Brings `from` (on the page) in line with `to` (the same element, freshly
// rendered by the server): its attributes, then its children. A child with
// an id or a data-morph-key is the one with the same id / key, wherever it
// was among them (the bottom bar, the team list — moved, not made anew); the
// rest are matched in order, each to the next one of its kind (node type and
// tag). Whatever has no match is made anew, and old ones left over removed.
// Some things are left as they are, being the page's own by now rather than
// the server's: an element with data-morph-key (the team list, an audio
// player — another key is another element), the attributes of one with
// data-morph-own-attrs (the bottom bar, collapsed or not), and <script>s.
function morph(from, to) {
  if (!from.hasAttribute('data-morph-own-attrs')) {
    Array.from(from.attributes).forEach((a) => {
      if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
    });
    Array.from(to.attributes).forEach((a) => {
      if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
    });
  }
  const oldKids = Array.from(from.childNodes);
  const keyed = new Map();
  const unkeyed = [];
  oldKids.forEach((n) => {
    const key = morphKey(n);
    if (key) keyed.set(key, n);
    else unkeyed.push(n);
  });
  const used = new Set();
  let next = 0; // the first unkeyed old child not passed over yet
  const nodes = Array.from(to.childNodes).map((newKid) => {
    const key = morphKey(newKid);
    let match = null;
    if (key) {
      match = keyed.get(key) || null;
    } else {
      const j = unkeyed.findIndex((n, k) => k >= next && sameKind(n, newKid));
      if (j >= 0) {
        match = unkeyed[j];
        next = j + 1;
      }
    }
    if (!match) return document.importNode(newKid, true);
    used.add(match);
    if (match.nodeType !== Node.ELEMENT_NODE) {
      if (match.nodeValue !== newKid.nodeValue) match.nodeValue = newKid.nodeValue;
    } else if (match.tagName !== 'SCRIPT' && !match.hasAttribute('data-morph-key')) {
      morph(match, newKid);
    }
    return match;
  });
  oldKids.forEach((n) => {
    if (!used.has(n)) n.remove();
  });
  // Then as few of the kept ones as possible are moved — a moved element is
  // taken off the page and put back, which starts its animations over (the
  // main button's wait strip) and pauses its track. The ones that stay put
  // are the most (an element counting for far more than a bit of text)
  // already in the wanted order; the rest, and the new ones, go in around them.
  const onPage = new Map(oldKids.filter((n) => used.has(n)).map((n, i) => [n, i]));
  const best = [];
  const before = [];
  nodes.forEach((node, i) => {
    if (!onPage.has(node)) return;
    const weight = node.nodeType === Node.ELEMENT_NODE ? 100 : 1;
    best[i] = weight;
    before[i] = -1;
    for (let j = 0; j < i; j++) {
      if (best[j] != null && onPage.get(nodes[j]) < onPage.get(node) && best[j] + weight > best[i]) {
        best[i] = best[j] + weight;
        before[i] = j;
      }
    }
  });
  let last = -1;
  best.forEach((b, i) => {
    if (b != null && (last < 0 || b > best[last])) last = i;
  });
  const staying = new Set();
  for (let i = last; i >= 0; i = before[i]) staying.add(nodes[i]);
  let ref = null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!staying.has(nodes[i])) from.insertBefore(nodes[i], ref);
    ref = nodes[i];
  }
}

function morphKey(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  if (node.hasAttribute('data-morph-key')) return `key:${node.getAttribute('data-morph-key')}`;
  return node.id ? `id:${node.id}` : null;
}

function sameKind(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
}

// The room page again from the server, with only what changed on it updated
// (morph) — no reload, so the team list, the bar, a playing track, the side
// panel and the socket stay as they are. Anything but a room page back
// (logged out, the room closed): loaded properly instead.
async function refreshRoom() {
  let doc = null;
  try {
    const res = await fetch(location.href, { cache: 'no-store' });
    if (res.ok && !res.redirected)
      doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  } catch (err) {}
  const next = doc && doc.getElementById('app');
  if (!next || !doc.getElementById('host-bar')) {
    location.reload();
    return;
  }
  document.title = doc.title;
  morph(document.getElementById('app'), next);
  initAudioBlocks();
  document.querySelectorAll('.audio-player-block').forEach((b) => b.quizAudio && b.quizAudio.syncBarButton());
  markUnanswered();
  applyCooldown();
}

// The bar's main button where it shows a new slide — the next question or
// hint, the stage's answers, its points, the next stage, the final results
// (data-cooldown on it) — can't be pressed for a moment after every move,
// with a strip along it running out meanwhile: a double click, or one tap
// too many on → after "Sekantis" has reached the newest question, can't show
// one more by accident. A move onto an earlier question ("Sekantis" is
// there — walking through those shows nothing new) doesn't start it again,
// only lets one already running finish; back on the newest, it starts.
// Going back, "Sekantis" and the numbers never wait themselves.
const NEXT_COOLDOWN_MS = 1500;
let cooldownUntil = 0;
let cooldownTimer = null;

function startCooldown() {
  if (!document.getElementById('forward-btn')) {
    cooldownUntil = Date.now() + NEXT_COOLDOWN_MS;
    // The strip starts over, full: taken off and drawn without it first, or
    // one still running would just carry on.
    const btn = document.getElementById('next-btn');
    if (btn) {
      btn.classList.remove('is-cooling');
      void btn.offsetWidth;
    }
  }
  applyCooldown();
}

// Also after a refresh, which puts the button back as the server has it —
// and this right back, the same, so a running strip carries on unbroken
// (only ever started over by startCooldown).
function applyCooldown() {
  clearTimeout(cooldownTimer);
  const btn = document.getElementById('next-btn');
  if (!btn || !btn.hasAttribute('data-cooldown')) return;
  const left = cooldownUntil - Date.now();
  const cooling = left > 0;
  btn.disabled = cooling;
  btn.classList.toggle('is-cooling', cooling);
  if (!cooling) return;
  btn.style.setProperty('--cooldown', `${NEXT_COOLDOWN_MS}ms`);
  cooldownTimer = setTimeout(applyCooldown, left);
}
startCooldown();

// Room pages: a move — next, back, a shown question's number, the final
// standings' views — is made on the server, then the page brought up to
// date (refreshRoom). One at a time: a double click or a held key can't
// skip past questions.
let moving = false;
async function roomMove(roomId, action, body) {
  if (moving) return;
  moving = true;
  try {
    const res = await fetch(`/api/host/room/${roomId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (res.ok) {
      await refreshRoom();
      startCooldown();
    }
  } finally {
    moving = false;
  }
}

// Next question / next stage (same endpoint drives both), and back to the
// previous question, restoring its picks (or from a stage's results back to
// its answers).
onClick('#next-btn', (btn) => roomMove(btn.dataset.room, 'next'));
onClick('#prev-btn', (btn) => roomMove(btn.dataset.room, 'prev'));

// Back on an earlier question, one step forward again through the ones
// already shown ("next" goes on to a new one instead).
onClick('#forward-btn', (btn) => roomMove(btn.dataset.room, 'goto', { index: Number(btn.dataset.index) }));

// The number buttons of the questions already shown — straight to that one
// (the active one is the question on screen now).
onClick('.question-jump-btn', (btn) => {
  if (btn.classList.contains('active')) return;
  roomMove(btn.closest('.question-jump').dataset.room, 'goto', { index: Number(btn.dataset.index) });
});

// Keyboard, on the pages with the bottom bar: ← back a question, → the next
// one already shown (after stepping back) or else the bar's main button
// (next question, start the stage, show the answers…), ↑ / ↓ the view
// screen's text bigger / smaller, space the track's ▶ / II, F the view
// screen's fullscreen picture (Shift+F a hidden one; Esc closes it too), B the bar itself
// collapsed / back ("bar"), a number straight to
// that question already shown (its number button). Not while typing into a
// field (a paper team's points), and one move at a time (see roomMove), so
// a held or double-tapped key can't skip past questions.
if (document.getElementById('host-bar')) {
  // Number keys: the physical key (e.code), so the top row works with the
  // Lithuanian layout too (ą č ę… there, digits only with Shift), and the
  // number pad with Num Lock on or off. Two digits typed in a row make one
  // number (12) — waited for only while a shown question's number could
  // still start with what's typed. 0 on its own is 10.
  const DIGIT_CODE = /^(?:Digit|Numpad)(\d)$/;
  const jumpButtons = () => Array.from(document.querySelectorAll('.question-jump-btn'));
  let typed = '';
  let typedTimer = null;
  function jumpTo(number) {
    typed = '';
    clearTimeout(typedTimer);
    const btn = jumpButtons().find((b) => b.textContent.trim() === number);
    if (btn) btn.click();
  }
  function typeDigit(digit) {
    clearTimeout(typedTimer);
    // 0 on its own is 10, like the last key of the row (after 9).
    if (!typed && digit === '0') {
      jumpTo('10');
      return;
    }
    typed += digit;
    const longer = jumpButtons().some((b) => {
      const n = b.textContent.trim();
      return n.length > typed.length && n.startsWith(typed);
    });
    if (longer) typedTimer = setTimeout(() => jumpTo(typed), 600);
    else jumpTo(typed);
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    const digit = (e.code || '').match(DIGIT_CODE);
    if (digit && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (!jumpButtons().length) return;
      e.preventDefault();
      if (!moving && !e.repeat) typeDigit(digit[1]);
      return;
    }
    // Shift+F: a hidden picture full screen on / off — kept off plain F, so
    // it isn't put up by mistake (it's usually what the answer looks like).
    if (e.code === 'KeyF' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const btn = document.getElementById('host-bar-hidden-img');
      if (btn && !e.repeat) btn.click();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const click = (id) => {
      const btn = document.getElementById(id);
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    };
    const scaleBtn = (delta) =>
      document.querySelector(`.text-scale-btn[data-delta="${delta}"]`);

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (moving || e.repeat) return;
      if (e.key === 'ArrowLeft') click('prev-btn');
      else click('forward-btn') || click('next-btn');
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const btn = scaleBtn(e.key === 'ArrowUp' ? 25 : -25);
      if (btn && !btn.disabled) btn.click();
    } else if (e.key === ' ') {
      // Space: the bar's ▶ / II — the marked part of the track, paused and
      // resumed. Kept from scrolling the page or pressing a focused button.
      e.preventDefault();
      if (!e.repeat) click('host-bar-audio');
    } else if (e.code === 'KeyF') {
      // F: the view screen's fullscreen picture on / off — only a question
      // with a picture (or picture options) has that button; a hidden
      // picture is Shift+F's. By the key's place (e.code), so any keyboard
      // layout works.
      if (!e.repeat) click('host-bar-fullscreen');
    } else if (e.code === 'KeyB') {
      // B: the bar collapsed / back, by the key's place like F.
      if (!e.repeat) click('host-bar-toggle');
    } else if (e.key === 'Escape') {
      // Esc: only closes an open fullscreen picture — never leaves the game
      // (too easy to hit by mistake; the ✕ is there for that).
      const openBtn = document.querySelector(
        '#host-bar-fullscreen[aria-pressed="true"], #host-bar-hidden-img[aria-pressed="true"]'
      );
      if (!e.repeat && openBtn) openBtn.click();
    }
  });
}

// Bottom bar: − / + for the view screen's text size (this page stays as
// it is). The server clamps it to 25%–500%; the buttons go grey at the ends.
onClick('.text-scale-btn', async (btn) => {
  const box = btn.closest('.text-scale');
  const res = await fetch(`/api/host/room/${box.dataset.room}/text-scale`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta: Number(btn.dataset.delta) })
  });
  if (!res.ok) return;
  const { scale, min, max } = await res.json();
  box.querySelector('.text-scale-value').textContent = `${scale}%`;
  box.querySelectorAll('.text-scale-btn').forEach((b) => {
    const delta = Number(b.dataset.delta);
    b.disabled = delta < 0 ? scale <= min : scale >= max;
  });
});

// Stage answers: mark a team's typed answer (or chain, or extra answer —
// the row's data-part) right (✓) or wrong (✗) — the active one is pre-set
// from the automatic match, and the server re-scores the question at once.
onClick('.typed-answer-btn', async (btn) => {
  if (btn.classList.contains('active')) return;
  const row = btn.closest('.typed-answer-row');
  const buttons = row.querySelectorAll('.typed-answer-btn');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const res = await fetch(`/api/host/room/${row.dataset.room}/typed-answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        index: Number(row.dataset.index),
        teamId: row.dataset.team,
        part: row.dataset.part,
        correct: btn.dataset.correct === 'true'
      })
    });
    if (res.ok) {
      const { correct } = await res.json();
      buttons.forEach((b) =>
        b.classList.toggle('active', (b.dataset.correct === 'true') === correct)
      );
    }
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

// The number buttons of the questions shown so far, outlined red while a
// team hasn't put anything into its answer — back to normal as soon as
// every team has (from the team list's pushes, kept for after a refresh).
// Not the one on screen now: the team list shows its answers already.
let lastUnanswered = {};
function markUnanswered(unanswered = lastUnanswered) {
  lastUnanswered = unanswered;
  document.querySelectorAll('.question-jump-btn').forEach((btn) => {
    const names = !btn.classList.contains('active') && unanswered[btn.dataset.index];
    btn.classList.toggle('is-unanswered', !!names);
    const title = names ? `Neatsakė: ${names.join(', ')}` : null;
    if (btn.getAttribute('title') === title) return;
    if (title) btn.title = title;
    else btn.removeAttribute('title');
  });
}

// Game-flow pages: live list of the room's teams and whether each phone can
// reach the internet (the hotspot has none, so it's mobile data). Phones
// re-check every 10s; a check older than this counts as unknown. The host
// can also add a team playing on paper (and enter its points per stage) and
// take any team out of the room.
const TEAM_STATUS_STALE_MS = 30000;
const teamStatusEl = document.getElementById('team-status');
if (teamStatusEl) {
  const listEl = teamStatusEl.querySelector('.team-status-list');
  const roomId = teamStatusEl.dataset.room;
  let teams = [];
  let paperEditable = false;
  let receivedAt = 0;
  // The team whose answers are shown under its row — one at a time.
  let openTeamId = null;

  function describe(team) {
    if (team.offline) return { cls: 'is-paper', icon: 'paper', text: 'Ant lapelio' };
    if (!team.connected) return { cls: 'is-offline', text: 'Atsijungęs' };
    const age = team.checkedAgoMs == null ? null : team.checkedAgoMs + (Date.now() - receivedAt);
    if (age == null || age > TEAM_STATUS_STALE_MS) return { cls: 'is-unknown', text: 'Tikrinama…' };
    return team.online
      ? { cls: 'is-online', icon: 'globe', text: 'Turi internetą' }
      : { cls: 'is-clean', icon: 'check', text: 'Be interneto' };
  }

  // Per team, what its row last showed (as a string) and the row's elements
  // (with its answers under it, if open) — pushes and the 5s ageing mostly
  // bring the same again, so only a row that would look different is built
  // anew, and the list's DOM is only touched when anything changed.
  const rowCache = new Map();

  function rowKey(team, status, hasAnswers, open) {
    return JSON.stringify([
      team.name, status, team.answer, team.offline && paperEditable && team.paperPoints,
      team.adjustment, team.penalty, hasAnswers, open, open && team.answers
    ]);
  }

  function render() {
    // Not while a paper team's points are being typed in — that'd wipe them.
    if (listEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')
      return;
    if (teams.length === 0) {
      rowCache.clear();
      if (listEl.querySelector('.team-status-row') || !listEl.firstChild) {
        const empty = document.createElement('p');
        empty.className = 'team-status-empty';
        empty.textContent = 'Kol kas neprisijungė nė viena komanda.';
        listEl.replaceChildren(empty);
      }
      return;
    }
    const seen = new Set();
    const nodes = [];
    teams.forEach((team) => {
      const status = describe(team);
      const hasAnswers = !!(team.answers && team.answers.length);
      const open = hasAnswers && team.teamId === openTeamId;
      const key = rowKey(team, status, hasAnswers, open);
      seen.add(team.teamId);
      let cached = rowCache.get(team.teamId);
      if (!cached || cached.key !== key) {
        cached = { key, nodes: buildRow(team, status, hasAnswers, open) };
        rowCache.set(team.teamId, cached);
      }
      nodes.push(...cached.nodes);
    });
    rowCache.forEach((_, teamId) => {
      if (!seen.has(teamId)) rowCache.delete(teamId);
    });
    const current = listEl.children;
    if (current.length !== nodes.length || nodes.some((n, i) => current[i] !== n))
      listEl.replaceChildren(...nodes);
  }

  function buildRow(team, { cls, icon, text }, hasAnswers, open) {
    const row = document.createElement('div');
    row.className = `team-status-row ${cls}`;
    const name = document.createElement('span');
    name.className = 'team-status-name';
    name.textContent = team.name;
    const badge = document.createElement('span');
    badge.className = 'team-status-badge';
    if (icon) badge.innerHTML = `${QuizIcons.icon(icon)} `;
    badge.append(text);
    if (hasAnswers) row.appendChild(answersToggle(team, open));
    row.append(name);
    if (team.answer) row.appendChild(answerStatus(team.answer));
    row.appendChild(badge);
    if (team.offline && paperEditable) row.appendChild(paperPointsField(team));
    row.appendChild(adjustControls(team));
    if (team.penalty != null) row.appendChild(penaltyControls(team));
    row.appendChild(removeButton(team));
    return open ? [row, answersPanel(team.answers)] : [row];
  }

  // The chevron before a phone team's name, as on the editor's stages: opens
  // the team's answers under its row (closing any other team's). As with the
  // seasons in the team history, the row stays where it is on screen while
  // the one open before shuts, then the page glides up until its top border
  // is at the very top of the screen — following it
  // by its team, as a push can build the row anew meanwhile.
  function answersToggle(team, open) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `toggle-stage-btn${open ? '' : ' collapsed'}`;
    b.innerHTML = '<span class="chevron-icon"></span>';
    b.title = open ? 'Slėpti atsakymus' : 'Rodyti atsakymus';
    b.setAttribute('aria-expanded', String(open));
    b.addEventListener('click', () => {
      openTeamId = open ? null : team.teamId;
      const row = () => (rowCache.get(team.teamId) || { nodes: [null] }).nodes[0];
      const before = row().getBoundingClientRect().top;
      render();
      if (open) return;
      window.scrollBy({ top: row().getBoundingClientRect().top - before, behavior: 'instant' });
      glide(row, 0, 300);
    });
    return b;
  }

  // A team's answers to the stage's questions shown so far: each question,
  // its right answer and the team's — in green while it counts, red while
  // it doesn't, greyed out with nothing typed — and the same for the extra
  // answer, in purple.
  function answersPanel(answers) {
    const panel = document.createElement('div');
    panel.className = 'team-answers-panel';
    const line = (cls, label, value) => {
      const p = document.createElement('p');
      p.className = `team-answers-line ${cls}`;
      const l = document.createElement('span');
      l.className = 'team-answers-label';
      l.textContent = label;
      p.append(l, value);
      return p;
    };
    const given = (text, correct, note) => {
      const span = document.createElement('span');
      if (!text && !correct) {
        span.className = 'team-answers-given is-empty';
        span.textContent = 'Neatsakyta';
        return span;
      }
      span.className = `team-answers-given ${correct ? 'is-correct' : 'is-wrong'}`;
      span.textContent = text || '—';
      if (note) {
        const n = document.createElement('span');
        n.className = 'team-answers-note';
        n.textContent = ` ${note}`;
        span.append(n);
      }
      return span;
    };
    answers.forEach((a) => {
      const item = document.createElement('div');
      item.className = 'team-answers-item';
      const q = document.createElement('p');
      q.className = 'team-answers-question';
      q.textContent = `${a.number}. ${a.question}`;
      item.append(
        q,
        line('', 'Teisingas:', a.correctAnswer || '—'),
        line('', 'Komandos:', given(a.given, a.correct,
          a.lockedPoints != null ? `(užrakinta už ${a.lockedPoints} tšk.)` : ''))
      );
      if (a.bonus) {
        item.append(
          line('is-bonus', 'Papildomas:', a.bonus.correctAnswer || '—'),
          line('is-bonus', 'Komandos:', given(a.bonus.given, a.bonus.correct))
        );
      }
      panel.appendChild(item);
    });
    return panel;
  }

  // The team's answer to the question on screen, as one icon (the words in
  // its tooltip) — the first of: being typed, locked in (for N points),
  // ready to move on (a hints question), all its fields filled in (a
  // crossed-out lock while it can still be locked in), some of them (2/3),
  // nothing yet. With an extra answer to give, a purple icon for it beside:
  // being typed, typed in, or not yet.
  function answerStatus(answer) {
    const wrap = document.createElement('span');
    wrap.className = 'team-answers';
    const add = (cls, iconName, title, text) => {
      const el = document.createElement('span');
      el.className = `team-answer ${cls}`;
      el.innerHTML = QuizIcons.icon(iconName);
      if (text != null) el.append(String(text));
      el.title = title;
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', title);
      wrap.appendChild(el);
    };
    if (answer.typing) add('is-typing', 'edit', 'Rašo atsakymą…');
    else if (answer.lockedPoints != null)
      add('is-locked', 'lock', `Atsakymas užrakintas už ${answer.lockedPoints} tšk.`, answer.lockedPoints);
    else if (answer.ready) add('is-ready', 'arrow-right', 'Galima judėti toliau');
    else if (answer.filled === 0) add('is-unanswered', 'circle-dashed', 'Neatsakyta');
    else if (answer.filled < answer.total)
      add('is-partial', 'check', `Atsakyta ${answer.filled} iš ${answer.total}`, `${answer.filled}/${answer.total}`);
    else if (answer.lockable) add('is-unlocked', 'lock-off', 'Atsakyta, bet neužrakinta');
    else add('is-answered', 'check', 'Atsakyta');

    if (answer.bonusFilled != null) {
      if (answer.typingBonus) add('is-bonus is-typing', 'edit', 'Rašo papildomą atsakymą…');
      else if (answer.bonusFilled) add('is-bonus is-answered', 'check', 'Papildomas atsakymas įrašytas');
      else add('is-bonus is-unanswered', 'circle-dashed', 'Papildomas atsakymas neįrašytas');
    }
    return wrap;
  }

  // − count + (a count that can't go below 0 greys its − out at 0); the new
  // count comes back with the next team-status push.
  function stepper(className, title, text, onChange, minusDisabled) {
    const wrap = document.createElement('span');
    wrap.className = `team-penalty ${className}`;
    wrap.title = title;
    const count = document.createElement('span');
    count.className = 'team-penalty-count';
    count.textContent = text;
    const button = (iconName, delta) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'team-penalty-btn';
      b.innerHTML = QuizIcons.icon(iconName);
      b.title = delta < 0 ? 'Atimti' : 'Pridėti';
      b.disabled = delta < 0 && !!minusDisabled;
      b.addEventListener('click', () => onChange(delta));
      return b;
    };
    wrap.append(button('minus', -1), count, button('plus', 1));
    return wrap;
  }

  // The team's penalty points this season.
  function penaltyControls(team) {
    return stepper('', 'Nuobaudos taškai šį sezoną', team.penalty,
      (delta) => changePenalty(team.teamId, delta), team.penalty === 0);
  }

  // The points the host gave (+) or took (−) this stage, on top of the
  // team's answers — labelled, unlike the penalty's red count beside it.
  function adjustControls(team) {
    const n = team.adjustment;
    const wrap = stepper('team-adjust', 'Pridėti / atimti taškai šiame etape',
      n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0', (delta) => adjustScore(team.teamId, delta));
    const label = document.createElement('span');
    label.className = 'team-adjust-label';
    label.textContent = 'Taškai:';
    wrap.prepend(label);
    return wrap;
  }

  async function adjustScore(teamId, delta) {
    const res = await fetch(`/api/host/room/${roomId}/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, delta })
    });
    if (!res.ok) return;
    // On the stage's results, they're shown changed.
    if ((await res.json()).results) refreshRoom();
  }

  // A paper team's points this stage, saved when the field is left.
  function paperPointsField(team) {
    const label = document.createElement('label');
    label.className = 'team-paper-points';
    label.title = 'Taškai, surinkti šiame etape (ant lapelio)';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '999';
    input.step = '1';
    input.inputMode = 'numeric';
    input.value = team.paperPoints;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('change', async () => {
      const points = Number(input.value);
      if (!Number.isInteger(points) || points < 0) {
        input.value = team.paperPoints;
        return;
      }
      await fetch(`/api/host/room/${roomId}/paper-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: team.teamId, points })
      });
    });
    // Built afresh even if nothing came back, so an unsaved number is reset.
    input.addEventListener('blur', () => {
      rowCache.delete(team.teamId);
      setTimeout(render, 0);
    });
    label.append('Etapo taškai', input);
    return label;
  }

  // Takes the team out of the room, after asking.
  function removeButton(team) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'team-remove-btn';
    b.innerHTML = QuizIcons.icon('close');
    b.title = 'Pašalinti komandą iš kambario';
    b.addEventListener('click', async () => {
      if (!confirm(`Pašalinti komandą „${team.name}“ iš kambario? Jos taškai šiame žaidime dings.`)) return;
      await fetch(`/api/host/room/${roomId}/teams/${encodeURIComponent(team.teamId)}`, { method: 'DELETE' });
    });
    return b;
  }

  // Adding a team playing on paper: "+ Nauja komanda" (picked to begin
  // with) and type its name, or pick a registered team not in the room.
  const addEl = teamStatusEl.querySelector('.team-add');
  const addSelect = addEl.querySelector('.team-add-select');
  const addName = addEl.querySelector('.team-add-name');
  const addBtn = addEl.querySelector('.team-add-btn');
  const addError = addEl.querySelector('.team-add-error');
  const NEW_TEAM = '__new';

  // Rebuilt only when the teams to pick from changed — rebuilding it closes
  // the list if it's open.
  let lastAvailable = null;
  function renderAddOptions(available, canAdd) {
    addEl.hidden = !canAdd;
    const key = JSON.stringify(available);
    if (key === lastAvailable) return;
    lastAvailable = key;
    const selected = addSelect.value;
    addSelect.innerHTML = '';
    const option = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      addSelect.appendChild(o);
    };
    option(NEW_TEAM, '+ Nauja komanda');
    available.forEach((t) => option(t.teamId, t.name));
    addSelect.value = Array.from(addSelect.options).some((o) => o.value === selected) ? selected : NEW_TEAM;
    syncAdd();
  }

  function syncAdd() {
    addName.hidden = addSelect.value !== NEW_TEAM;
    addBtn.disabled = !addSelect.value || (addSelect.value === NEW_TEAM && !addName.value.trim());
  }
  addSelect.addEventListener('change', () => {
    addError.textContent = '';
    syncAdd();
    if (addSelect.value === NEW_TEAM) addName.focus();
  });
  addName.addEventListener('input', syncAdd);
  addName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !addBtn.disabled) addBtn.click();
  });
  addBtn.addEventListener('click', async () => {
    const body =
      addSelect.value === NEW_TEAM ? { name: addName.value.trim() } : { teamId: addSelect.value };
    addBtn.disabled = true;
    addError.textContent = '';
    try {
      const res = await fetch(`/api/host/room/${roomId}/offline-team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        addError.textContent = (await res.json().catch(() => ({}))).error || 'Nepavyko pridėti';
        return;
      }
      addSelect.value = NEW_TEAM;
      addName.value = '';
    } finally {
      syncAdd();
    }
  });

  async function changePenalty(teamId, delta) {
    await fetch(`/api/host/room/${teamStatusEl.dataset.room}/penalty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, delta })
    });
  }

  const socket = getHostSocket();
  const watch = () => socket.emit('host-watch', teamStatusEl.dataset.room);
  socket.on('connect', watch);
  if (socket.connected) watch();
  let stageIndex = null;
  socket.on('team-status', (status) => {
    // On to a new stage: the open team's answers shut (its questions are
    // gone), and stay shut once the new stage's come in.
    if (stageIndex != null && status.stageIndex !== stageIndex) openTeamId = null;
    stageIndex = status.stageIndex;
    teams = status.teams;
    paperEditable = status.paperEditable;
    receivedAt = Date.now();
    render();
    renderAddOptions(status.available, status.canAdd);
    markUnanswered(status.unanswered || {});
  });
  // Ages the last checks even when nothing new arrives.
  setInterval(render, 5000);

  // Switches the "turn off mobile data" overlay on players' phones on/off
  // for this room; every host tab gets the new state back over the socket.
  const warningBtn = teamStatusEl.querySelector('.internet-warning-toggle');
  socket.on('internet-warning', ({ enabled }) => {
    warningBtn.hidden = false;
    warningBtn.classList.toggle('is-off', !enabled);
    // Just the bell (struck through while off); the words in its tooltip.
    warningBtn.innerHTML = QuizIcons.icon(enabled ? 'bell' : 'bell-off');
    warningBtn.title = `Įspėjimas žaidėjams: ${enabled ? 'įjungtas' : 'išjungtas'}`;
    warningBtn.setAttribute('aria-label', `Įspėjimas žaidėjams: ${enabled ? 'įjungtas' : 'išjungtas'}`);
  });
  warningBtn.addEventListener('click', async () => {
    warningBtn.disabled = true;
    try {
      await fetch(`/api/host/room/${teamStatusEl.dataset.room}/internet-warning-toggle`, { method: 'POST' });
    } finally {
      warningBtn.disabled = false;
    }
  });
}

// Leaderboard: switch between this game's standings, the season's and the
// season's penalty points
onClick('.leaderboard-view-btn', (btn) =>
  roomMove(btn.dataset.id, 'leaderboard-view', { view: btn.dataset.view })
);

// Leaderboard: finish game (closes the room)
onClick('#finish-game-btn', async (btn) => {
  await fetch(`/api/host/room/${btn.dataset.id}`, { method: 'DELETE' });
  window.location.href = '/host';
});

// Team history: a team's "ID" / "Nuobaudos" buttons show its id / penalty
// points instead, and hide them again on the next click.
document.querySelectorAll('.reveal-btn').forEach((btn) => {
  const hiddenTitle = btn.title;
  btn.addEventListener('click', () => {
    const shown = btn.classList.toggle('is-shown');
    btn.textContent = shown ? btn.dataset.value : btn.dataset.label;
    btn.title = shown ? 'Slėpti' : hiddenTitle;
  });
});

// Team history: a team's pencil turns the − / + beside its stages' points
// on and off — off to begin with, so a stray click (or anyone the page is
// shown to) can't change them. Each click is saved at once, and the game's
// and season's totals follow.
document.querySelectorAll('.team-card').forEach((card) => {
  const editBtn = card.querySelector('.team-edit-btn');
  if (!editBtn) return;
  editBtn.addEventListener('click', () => {
    const editing = card.classList.toggle('is-editing');
    editBtn.setAttribute('aria-pressed', String(editing));
    editBtn.title = editing ? 'Baigti taisyti' : 'Taisyti taškus';
  });

  const section = card.closest('.season-section');

  // The ✕ beside a game's total: out of the team's history for this season,
  // after asking. The team's card goes too once it has no games left here.
  card.querySelectorAll('.game-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const block = btn.closest('.game-block');
      const gameName = block.querySelector('.game-block-name').textContent;
      const teamName = card.querySelector('.team-card-name').textContent;
      if (!confirm(`Pašalinti žaidimą „${gameName}“ iš komandos „${teamName}“ ${section.dataset.seasonId} sezono istorijos? Jo taškai dings.`)) return;
      btn.disabled = true;
      try {
        const res = await fetch(
          `/api/host/teams/${encodeURIComponent(card.dataset.teamId)}/seasons/${encodeURIComponent(section.dataset.seasonId)}/games/${encodeURIComponent(block.dataset.gameId)}`,
          { method: 'DELETE' }
        );
        if (!res.ok) return;
        const { seasonTotal } = await res.json();
        block.remove();
        if (!card.querySelector('.game-block')) card.remove();
        else card.querySelector('.team-card-total').textContent = `${seasonTotal} tšk.`;
      } finally {
        btn.disabled = false;
      }
    });
  });

  card.querySelectorAll('.stage-line').forEach((line) => {
    line.querySelectorAll('.stage-score-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await fetch(`/api/host/teams/${encodeURIComponent(card.dataset.teamId)}/score`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              seasonId: section.dataset.seasonId,
              gameId: line.closest('.game-block').dataset.gameId,
              stageId: line.dataset.stageId,
              delta: Number(btn.dataset.delta)
            })
          });
          if (!res.ok) return;
          const { score, gameTotal, seasonTotal } = await res.json();
          line.querySelector('.stage-score').textContent = score;
          line.closest('.game-block').querySelector('.game-block-total').textContent = `${gameTotal} tšk.`;
          card.querySelector('.team-card-total').textContent = `${seasonTotal} tšk.`;
        } finally {
          btn.disabled = false;
        }
      });
    });
  });
});

// Team history: each season's chevron collapses/expands its section, the
// same way (and with the same button) as a stage in the game editor — see
// attachCollapse in game-editor-core.js. The active season starts open (the
// newest if the active one has no history — server.js), and
// one is open at a time. As with the editor's stages (collapseOtherStages
// in game-editor-core.js), in two steps: the opened season slides open
// while the page scrolls up to it, then the rest slide shut while the page
// keeps it where it is on screen.

// Up to the top (its scroll-margin), over the 0.3s a section takes to open.
function scrollAlong(el, done) {
  glide(el, parseFloat(getComputedStyle(el).scrollMarginTop) || 0, 300, done);
}

// Scrolls the page, frame by frame, so el's top on screen moves from where
// it is to `to` (null: stays put) over `duration` ms — whatever grows or
// shrinks around it meanwhile. done, if any, once it's there. el can be a
// function giving it, for one that may be built anew on the way — if it's
// gone from the page, the scrolling just stops.
function glide(el, to, duration, done) {
  const node = () => (typeof el === 'function' ? el() : el);
  const from = node().getBoundingClientRect().top;
  const target = to == null ? from : to;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const start = performance.now();
  const step = () => {
    const current = node();
    if (!current || !current.isConnected) return;
    const t = Math.min(1, (performance.now() - start) / duration);
    const wanted = from + (target - from) * ease(t);
    const drift = current.getBoundingClientRect().top - wanted;
    if (drift) window.scrollBy({ top: drift, behavior: 'instant' });
    if (t < 1) requestAnimationFrame(step);
    else if (done) done();
  };
  requestAnimationFrame(step);
}
const seasonSections = Array.from(document.querySelectorAll('.season-section'));
seasonSections.forEach((section) => {
  const toggleBtn = section.querySelector('.toggle-stage-btn');
  const body = section.querySelector('.season-section-body');
  let collapsed = toggleBtn.classList.contains('collapsed');

  function set(value, animate = true) {
    if (value === collapsed) return;
    collapsed = value;
    toggleBtn.classList.toggle('collapsed', collapsed);

    if (!animate) {
      body.style.transition = 'none';
      body.style.maxHeight = collapsed ? '0px' : 'none';
      void body.offsetHeight; // apply it before the transition is back
      body.style.transition = '';
    } else if (collapsed) {
      body.style.maxHeight = body.scrollHeight + 'px';
      requestAnimationFrame(() => {
        body.style.maxHeight = '0px';
      });
    } else {
      body.style.maxHeight = body.scrollHeight + 'px';
      body.addEventListener('transitionend', function onDone(e) {
        if (e.propertyName !== 'max-height') return;
        body.removeEventListener('transitionend', onDone);
        if (!collapsed) body.style.maxHeight = 'none'; // let it grow freely again
      });
    }
  }
  section.collapse = { set, isCollapsed: () => collapsed };

  toggleBtn.addEventListener('click', () => {
    set(!collapsed);
    if (collapsed) return;
    scrollAlong(section, () => {
      seasonSections.forEach((other) => {
        if (other !== section) other.collapse.set(true);
      });
      glide(section, null, 350);
    });
  });
});

// The season open on arrival scrolled to, unless it's the first one —
// already in view, under the heading.
const openSeason = seasonSections.find((s) => !s.collapse.isCollapsed());
if (openSeason && openSeason !== seasonSections[0]) scrollAlong(openSeason);

// The seasons in the side panel too, numbered like the editor's stages:
// clicking one opens it (shutting the others) and scrolls to it.
if (seasonSections.length && window.QuizSidePanel) {
  const sidePanel = QuizSidePanel.mount();
  const seasonsEl = sidePanel.addSection('Sezonai');
  seasonSections.forEach((section) => {
    const seasonId = section.dataset.seasonId;
    seasonsEl.appendChild(
      sidePanel.createItem(
        seasonId,
        `Sezonas ${seasonId}`,
        () => {
          // Opening it scrolls to it (the chevron's handler); already open,
          // just scroll.
          if (section.collapse.isCollapsed()) section.querySelector('.toggle-stage-btn').click();
          else scrollAlong(section);
        },
        'side-panel-stage'
      )
    );
  });
}
