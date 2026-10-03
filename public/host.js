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

// Each .audio-player-block holds a muted <audio> — muted because it's only
// here so the host can see and drive playback (its controls from
// audio-player.js: bar, elapsed time, volume); the actual sound comes from the view screen's own (unmuted)
// element, which mirrors every play/pause/seek/volume change as a state
// snapshot. There can be more than one block on a page (stage-answers lists
// every question in the stage), so this is wired per-block, not by fixed id.
const audioBlocks = Array.from(document.querySelectorAll('.audio-player-block'));
const allQuestionAudios = audioBlocks
  .map((block) => block.querySelector('.question-audio'))
  .filter(Boolean);

function pauseOtherAudioBlocks(except) {
  allQuestionAudios.forEach((a) => {
    if (a !== except && !a.paused) a.pause();
  });
}

audioBlocks.forEach((block) => {
  const questionAudio = block.querySelector('.question-audio');
  if (!questionAudio) return;
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

  function playClip() {
    pauseOtherAudioBlocks(questionAudio);
    clipModeActive = true;
    clipEndReached = false;
    questionAudio.currentTime = clipStart;
    questionAudio.play();
  }

  function playNormal() {
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
  const barPlayBtn = document.getElementById('host-bar-audio');
  const barStopBtn = document.getElementById('host-bar-audio-stop');
  if (!barPlayBtn || audioBlocks.length !== 1) return;

  const hasClip = !!playClipBtn;
  let stopped = true; // next ▶ starts over rather than resuming

  function syncBarButton() {
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

  barPlayBtn.addEventListener('click', () => {
    if (!questionAudio.paused) {
      questionAudio.pause();
    } else if (stopped) {
      if (hasClip) playClip();
      else playNormal();
    } else {
      questionAudio.play();
    }
  });

  barStopBtn.addEventListener('click', () => {
    stopped = true;
    questionAudio.pause();
    questionAudio.currentTime = clipModeActive ? clipStart : 0;
  });
});

// Room panel + stage-answers review: remotely trigger (or dismiss) the view
// screen's fullscreen image display — the view screen has no clickable
// controls of its own for this, it just reacts to whatever the host sends.
// The actual image URL(s) travel with the command, since a stage-answers
// block isn't showing the live question view has loaded.
function sendFullscreenCommand(roomId, payload) {
  getHostSocket().emit('fullscreen-command', { roomId, ...payload });
  setBarFullscreenState(payload.action !== 'close');
}

function parseImagesAttr(value) {
  try {
    return JSON.parse(value) || [];
  } catch (err) {
    return [];
  }
}

// Room panel bottom bar: one button that opens the question's picture (or,
// without one, its picture options) on the view screen, and closes it again.
// It only knows what this page sent — the view screen closes it by itself
// when the host moves on, and moving on reloads this page anyway.
const barFullscreenBtn = document.getElementById('host-bar-fullscreen');
let barFullscreenOpen = false;

function setBarFullscreenState(open) {
  barFullscreenOpen = open;
  if (!barFullscreenBtn) return;
  barFullscreenBtn.classList.toggle('is-active', open);
  barFullscreenBtn.setAttribute('aria-pressed', String(open));
  barFullscreenBtn.title = open ? 'Uždaryti pilną ekraną' : 'Per visą ekraną (žiūrovų ekrane)';
}

if (barFullscreenBtn) {
  barFullscreenBtn.addEventListener('click', () => {
    const roomId = barFullscreenBtn.dataset.room;
    if (barFullscreenOpen) {
      sendFullscreenCommand(roomId, { action: 'close' });
    } else if (barFullscreenBtn.dataset.src) {
      sendFullscreenCommand(roomId, { action: 'image', src: barFullscreenBtn.dataset.src });
    } else {
      sendFullscreenCommand(roomId, { action: 'options', images: parseImagesAttr(barFullscreenBtn.dataset.images) });
    }
  });
}

document.querySelectorAll('.fullscreen-mode-buttons').forEach((block) => {
  const roomId = block.dataset.room;

  block.querySelectorAll('.fullscreen-image-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      sendFullscreenCommand(roomId, { action: 'image', src: btn.dataset.src });
    });
  });

  const optionsBtn = block.querySelector('.fullscreen-options-btn');
  if (optionsBtn) {
    optionsBtn.addEventListener('click', () => {
      sendFullscreenCommand(roomId, { action: 'options', images: parseImagesAttr(optionsBtn.dataset.images) });
    });
  }

  const closeBtn = block.querySelector('.fullscreen-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => sendFullscreenCommand(roomId, { action: 'close' }));
  }
});

// Room panel: next question / next stage (same endpoint drives both)
const nextBtn = document.getElementById('next-btn');
if (nextBtn) {
  nextBtn.addEventListener('click', async () => {
    const res = await fetch(`/api/host/room/${nextBtn.dataset.room}/next`, { method: 'POST' });
    if (!res.ok) return;
    window.location.reload();
  });
}

// Room panel: back to the previous question, restoring its picks
const prevBtn = document.getElementById('prev-btn');
if (prevBtn) {
  prevBtn.addEventListener('click', async () => {
    const res = await fetch(`/api/host/room/${prevBtn.dataset.room}/prev`, { method: 'POST' });
    if (!res.ok) return;
    window.location.reload();
  });
}

// Keyboard, on the pages with the bottom bar: ← back a question, → the next
// one already shown (after stepping back) or else the bar's main button
// (next question, start the stage, show the answers…), ↑ / ↓ the view
// screen's text bigger / smaller, space the track's ▶ / II, F the view
// screen's fullscreen picture (Esc closes it too), a number straight to
// that question already shown (its number button). Not while typing into a
// field (a paper team's points), and one move per page — each reloads it,
// so a held or double-tapped key can't skip past questions.
if (document.getElementById('host-bar')) {
  // Set while a move's page reload is on its way, so a second key press
  // can't move again; let go after a while in case no reload comes (a failed
  // request), so the keys never stay locked.
  let navigating = false;
  let navigatingTimer = null;
  function startNavigating() {
    navigating = true;
    clearTimeout(navigatingTimer);
    navigatingTimer = setTimeout(() => {
      navigating = false;
    }, 3000);
  }

  // Number keys: the physical key (e.code), so the top row works with the
  // Lithuanian layout too (ą č ę… there, digits only with Shift), and the
  // number pad with Num Lock on or off. Two digits typed in a row make one
  // number (12) — waited for only while a shown question's number could
  // still start with what's typed. 0 on its own is 10.
  const DIGIT_CODE = /^(?:Digit|Numpad)(\d)$/;
  const jumpButtons = Array.from(document.querySelectorAll('.question-jump-btn'));
  let typed = '';
  let typedTimer = null;
  function jumpTo(number) {
    typed = '';
    clearTimeout(typedTimer);
    const btn = jumpButtons.find((b) => b.textContent.trim() === number);
    if (!btn || btn.classList.contains('active')) return;
    startNavigating();
    btn.click();
  }
  function typeDigit(digit) {
    clearTimeout(typedTimer);
    // 0 on its own is 10, like the last key of the row (after 9).
    if (!typed && digit === '0') {
      jumpTo('10');
      return;
    }
    typed += digit;
    const longer = jumpButtons.some((b) => {
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
      if (!jumpButtons.length) return;
      e.preventDefault();
      if (!navigating && !e.repeat) typeDigit(digit[1]);
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
      if (navigating || e.repeat) return;
      const done =
        e.key === 'ArrowLeft'
          ? click('prev-btn')
          : click('forward-btn') || click('next-btn');
      if (done) startNavigating();
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
      // with a picture (or picture options) has that button. By the key's
      // place (e.code), so any keyboard layout works.
      if (!e.repeat) click('host-bar-fullscreen');
    } else if (e.key === 'Escape') {
      // Esc: only closes an open fullscreen picture — never leaves the game
      // (too easy to hit by mistake; the ✕ is there for that).
      const fullscreenBtn = document.getElementById('host-bar-fullscreen');
      if (!e.repeat && fullscreenBtn && fullscreenBtn.getAttribute('aria-pressed') === 'true')
        fullscreenBtn.click();
    }
  });
}

// Bottom bar: − / + for the view screen's text size (this page stays as
// it is). The server clamps it to 25%–500%; the buttons go grey at the ends.
document.querySelectorAll('.text-scale').forEach((box) => {
  const valueEl = box.querySelector('.text-scale-value');
  const buttons = box.querySelectorAll('.text-scale-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await fetch(`/api/host/room/${box.dataset.room}/text-scale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: Number(btn.dataset.delta) })
      });
      if (!res.ok) return;
      const { scale, min, max } = await res.json();
      valueEl.textContent = `${scale}%`;
      buttons.forEach((b) => {
        const delta = Number(b.dataset.delta);
        b.disabled = delta < 0 ? scale <= min : scale >= max;
      });
    });
  });
});

// Room panel: back on an earlier question, one step forward again through
// the ones already shown ("next" goes on to a new one instead).
const forwardBtn = document.getElementById('forward-btn');
if (forwardBtn) {
  forwardBtn.addEventListener('click', async () => {
    const res = await fetch(`/api/host/room/${forwardBtn.dataset.room}/goto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: Number(forwardBtn.dataset.index) })
    });
    if (!res.ok) return;
    window.location.reload();
  });
}

// Room panel: the number buttons of the questions already shown — straight
// to that one (the active one is the question on screen now).
document.querySelectorAll('.question-jump').forEach((nav) => {
  nav.querySelectorAll('.question-jump-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('active')) return;
      const res = await fetch(`/api/host/room/${nav.dataset.room}/goto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: Number(btn.dataset.index) })
      });
      if (!res.ok) return;
      window.location.reload();
    });
  });
});

// Stage answers: mark a team's typed answer (or chain, or extra answer —
// the row's data-part) right (✓) or wrong (✗) — the active one is pre-set
// from the automatic match, and the server re-scores the question at once.
document.querySelectorAll('.typed-answer-row').forEach((row) => {
  const buttons = row.querySelectorAll('.typed-answer-btn');
  if (buttons.length === 0) return;

  function show(correct) {
    buttons.forEach((b) =>
      b.classList.toggle('active', (b.dataset.correct === 'true') === correct)
    );
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('active')) return;
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
        if (res.ok) show((await res.json()).correct);
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    });
  });
});

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

  function describe(team) {
    if (team.offline) return { cls: 'is-paper', icon: 'paper', text: 'Ant lapelio' };
    if (!team.connected) return { cls: 'is-offline', text: 'Atsijungęs' };
    const age = team.checkedAgoMs == null ? null : team.checkedAgoMs + (Date.now() - receivedAt);
    if (age == null || age > TEAM_STATUS_STALE_MS) return { cls: 'is-unknown', text: 'Tikrinama…' };
    return team.online
      ? { cls: 'is-online', icon: 'globe', text: 'Turi internetą' }
      : { cls: 'is-clean', icon: 'check', text: 'Be interneto' };
  }

  function render() {
    // Not while a paper team's points are being typed in — that'd wipe them.
    if (listEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')
      return;
    listEl.innerHTML = '';
    if (teams.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'team-status-empty';
      empty.textContent = 'Kol kas neprisijungė nė viena komanda.';
      listEl.appendChild(empty);
      return;
    }
    teams.forEach((team) => {
      const { cls, icon, text } = describe(team);
      const row = document.createElement('div');
      row.className = `team-status-row ${cls}`;
      const name = document.createElement('span');
      name.className = 'team-status-name';
      name.textContent = team.name;
      const badge = document.createElement('span');
      badge.className = 'team-status-badge';
      if (icon) badge.innerHTML = `${QuizIcons.icon(icon)} `;
      badge.append(text);
      row.append(name, badge);
      if (team.offline && paperEditable) row.appendChild(paperPointsField(team));
      if (team.penalty != null) row.appendChild(penaltyControls(team));
      row.appendChild(removeButton(team));
      listEl.appendChild(row);
    });
  }

  // − count + for the team's penalty points this season; the new count
  // comes back with the next team-status push.
  function penaltyControls(team) {
    const wrap = document.createElement('span');
    wrap.className = 'team-penalty';
    wrap.title = 'Nuobaudos taškai šį sezoną';
    const count = document.createElement('span');
    count.className = 'team-penalty-count';
    count.textContent = team.penalty;
    const button = (iconName, delta) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'team-penalty-btn';
      b.innerHTML = QuizIcons.icon(iconName);
      b.title = delta < 0 ? 'Atimti' : 'Pridėti';
      b.disabled = delta < 0 && team.penalty === 0;
      b.addEventListener('click', () => changePenalty(team.teamId, delta));
      return b;
    };
    wrap.append(button('minus', -1), count, button('plus', 1));
    return wrap;
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
    input.addEventListener('blur', () => setTimeout(render, 0));
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

  function renderAddOptions(available, canAdd) {
    addEl.hidden = !canAdd;
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
  socket.on('team-status', (status) => {
    teams = status.teams;
    paperEditable = status.paperEditable;
    receivedAt = Date.now();
    render();
    renderAddOptions(status.available, status.canAdd);
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
document.querySelectorAll('.leaderboard-view-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const res = await fetch(`/api/host/room/${btn.dataset.id}/leaderboard-view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: btn.dataset.view })
    });
    if (!res.ok) return;
    window.location.reload();
  });
});

// Leaderboard: finish game (closes the room)
const finishGameBtn = document.getElementById('finish-game-btn');
if (finishGameBtn) {
  finishGameBtn.addEventListener('click', async () => {
    await fetch(`/api/host/room/${finishGameBtn.dataset.id}`, { method: 'DELETE' });
    window.location.href = '/host';
  });
}

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

// Team history: each season's chevron collapses/expands its section, the
// same way (and with the same button) as a stage in the game editor — see
// attachCollapse in game-editor-core.js. The newest season starts open, and
// one is open at a time: opening another shuts the rest at once, keeping
// the opened one where it was on screen.
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
    const before = section.getBoundingClientRect().top;
    seasonSections.forEach((other) => {
      if (other !== section) other.collapse.set(true, false);
    });
    window.scrollBy({ top: section.getBoundingClientRect().top - before, behavior: 'instant' });
  });
});

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
          if (section.collapse.isCollapsed()) {
            section.querySelector('.toggle-stage-btn').click();
          }
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
        'side-panel-stage'
      )
    );
  });
}
