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
// here so the host can see and drive playback (native scrubber, elapsed time,
// volume); the actual sound comes from the view screen's own (unmuted)
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
    barPlayBtn.textContent = playing ? 'II' : '▶';
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
// re-check every 10s; a check older than this counts as unknown.
const TEAM_STATUS_STALE_MS = 30000;
const teamStatusEl = document.getElementById('team-status');
if (teamStatusEl) {
  const listEl = teamStatusEl.querySelector('.team-status-list');
  let teams = [];
  let receivedAt = 0;

  function describe(team) {
    if (!team.connected) return { cls: 'is-offline', text: 'Atsijungęs' };
    const age = team.checkedAgoMs == null ? null : team.checkedAgoMs + (Date.now() - receivedAt);
    if (age == null || age > TEAM_STATUS_STALE_MS) return { cls: 'is-unknown', text: 'Tikrinama…' };
    return team.online
      ? { cls: 'is-online', text: '🌐 Turi internetą' }
      : { cls: 'is-clean', text: '✓ Be interneto' };
  }

  function render() {
    listEl.innerHTML = '';
    if (teams.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'team-status-empty';
      empty.textContent = 'Kol kas neprisijungė nė viena komanda.';
      listEl.appendChild(empty);
      return;
    }
    teams.forEach((team) => {
      const { cls, text } = describe(team);
      const row = document.createElement('div');
      row.className = `team-status-row ${cls}`;
      const name = document.createElement('span');
      name.className = 'team-status-name';
      name.textContent = team.name;
      const badge = document.createElement('span');
      badge.className = 'team-status-badge';
      badge.textContent = text;
      row.append(name, badge);
      if (team.penalty != null) row.appendChild(penaltyControls(team));
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
    const button = (label, delta) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'team-penalty-btn';
      b.textContent = label;
      b.disabled = delta < 0 && team.penalty === 0;
      b.addEventListener('click', () => changePenalty(team.teamId, delta));
      return b;
    };
    wrap.append(button('−', -1), count, button('+', 1));
    return wrap;
  }

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
  socket.on('team-status', (list) => {
    teams = list;
    receivedAt = Date.now();
    render();
  });
  // Ages the last checks even when nothing new arrives.
  setInterval(render, 5000);

  // Switches the "turn off mobile data" overlay on players' phones on/off
  // for this room; every host tab gets the new state back over the socket.
  const warningBtn = teamStatusEl.querySelector('.internet-warning-toggle');
  socket.on('internet-warning', ({ enabled }) => {
    warningBtn.hidden = false;
    warningBtn.classList.toggle('is-off', !enabled);
    warningBtn.textContent = enabled
      ? '🔔 Įspėjimas žaidėjams: įjungtas'
      : '🔕 Įspėjimas žaidėjams: išjungtas';
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
// createStageCard in game-editor-core.js. Older seasons start collapsed.
document.querySelectorAll('.season-section').forEach((section) => {
  const toggleBtn = section.querySelector('.toggle-stage-btn');
  const body = section.querySelector('.season-section-body');
  let collapsed = toggleBtn.classList.contains('collapsed');

  toggleBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    toggleBtn.classList.toggle('collapsed', collapsed);

    if (collapsed) {
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
  });
});
