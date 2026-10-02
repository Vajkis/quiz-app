const TEAM_KEY = 'quizTeam';
const ROOM_ID = document.body.dataset.room;

const teamNameEl = document.getElementById('team-name');
const teamIdEl = document.getElementById('team-id');
const leaveRoomBtn = document.getElementById('leave-room-btn');

const quizEl = document.getElementById('quiz');
const resultEl = document.getElementById('result');
const leaderboardEl = document.getElementById('leaderboard');

function getStoredTeam() {
  try {
    return JSON.parse(localStorage.getItem(TEAM_KEY));
  } catch (err) {
    return null;
  }
}

// The game's hotspot has no internet, so a phone that can still reach an
// outside site has another way online (mobile data) — reported to the host.
// A no-cors request is enough: it only fails when the site can't be reached.
const INTERNET_CHECK_URLS = [
  'https://www.gstatic.com/generate_204',
  'https://cloudflare.com/cdn-cgi/trace'
];
const INTERNET_CHECK_INTERVAL_MS = 10000;
// Re-checked more often while the "turn off mobile data" overlay is up, so
// it goes away soon after the player actually does it.
const INTERNET_RECHECK_WHILE_BLOCKED_MS = 3000;
const INTERNET_CHECK_TIMEOUT_MS = 4000;

const internetOverlayEl = document.getElementById('internet-overlay');

// The host can switch the overlay off for the room (and back on) — the
// server sends the room's setting on joining and on every change. Checks
// and reports to the host carry on either way.
let internetWarningEnabled = false;

// Same dimmed full-screen look as the view screen's image overlay.
function showInternetOverlay(show) {
  if (show) {
    internetOverlayEl.hidden = false;
    requestAnimationFrame(() => internetOverlayEl.classList.add('visible'));
  } else {
    internetOverlayEl.classList.remove('visible');
    internetOverlayEl.hidden = true;
  }
}

function canReach(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERNET_CHECK_TIMEOUT_MS);
  return fetch(`${url}?t=${Date.now()}`, {
    mode: 'no-cors',
    cache: 'no-store',
    signal: controller.signal
  })
    .then(() => true, () => false)
    .finally(() => clearTimeout(timer));
}

let internetCheckRunning = false;
let internetCheckTimer = null;
async function checkInternet(socket) {
  if (internetCheckRunning) return;
  internetCheckRunning = true;
  clearTimeout(internetCheckTimer);
  let online = false;
  try {
    const results = await Promise.all(INTERNET_CHECK_URLS.map(canReach));
    online = results.some(Boolean);
    showInternetOverlay(online && internetWarningEnabled);
    if (socket.connected) socket.emit('internet-status', { online });
  } finally {
    internetCheckRunning = false;
    internetCheckTimer = setTimeout(
      () => checkInternet(socket),
      online && internetWarningEnabled
        ? INTERNET_RECHECK_WHILE_BLOCKED_MS
        : INTERNET_CHECK_INTERVAL_MS
    );
  }
}

const currentTeam = getStoredTeam();

if (!currentTeam) {
  window.location.href = '/';
} else {
  teamNameEl.textContent = currentTeam.name;
  teamIdEl.textContent = currentTeam.id;

  leaveRoomBtn.addEventListener('click', () => {
    window.location.href = '/';
  });

  const socket = io();

  socket.on('connect', () => {
    socket.emit('join-room', {
      roomId: ROOM_ID,
      teamId: currentTeam.id,
      teamName: currentTeam.name
    });
    checkInternet(socket);
  });

  document
    .getElementById('internet-recheck-btn')
    .addEventListener('click', () => checkInternet(socket));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkInternet(socket);
  });
  window.addEventListener('online', () => checkInternet(socket));
  window.addEventListener('offline', () => checkInternet(socket));

  socket.on('internet-warning', ({ enabled }) => {
    internetWarningEnabled = !!enabled;
    if (!internetWarningEnabled) showInternetOverlay(false);
    else checkInternet(socket);
  });

  // The host took this team out of the room (e.g. it joined under a wrong
  // name): back to the join page, to join again as the right team.
  socket.on('team-removed', () => {
    try {
      localStorage.removeItem(TEAM_KEY);
    } catch (err) {}
    alert('Vedėjas pašalino jūsų komandą iš kambario.');
    window.location.href = '/';
  });

  socket.on('room-closed', () => {
    alert('Hostas uždarė kambarį.');
    window.location.href = '/';
  });

  socket.on('question', (q) => {
    resultEl.textContent = '';
    leaderboardEl.hidden = true;
    quizEl.hidden = false;
    renderQuestion(q, socket);
  });

  socket.on('stage-answers', () => {
    quizEl.hidden = true;
    leaderboardEl.hidden = true;
    resultEl.textContent = '';
  });

  // Host has moved past the stage leaderboard onto the next stage's (or the
  // whole game's) intro — without this, the previous stage's point totals
  // just stayed on screen the whole time the host was showing the next
  // stage's name, right up until the first question of that stage arrived.
  socket.on('game-intro', () => {
    quizEl.hidden = true;
    leaderboardEl.hidden = true;
    resultEl.textContent = '';
  });

  // The rules are on the big screen only, like the game's name.
  socket.on('game-rules', () => {
    quizEl.hidden = true;
    leaderboardEl.hidden = true;
    resultEl.textContent = '';
  });

  socket.on('stage-intro', () => {
    quizEl.hidden = true;
    leaderboardEl.hidden = true;
    resultEl.textContent = '';
  });

  socket.on('leaderboard', (payload) => {
    renderLeaderboard(payload);
  });
}

function renderLeaderboard({ rows, final, stageName, seasonId, penalties }) {
  quizEl.hidden = true;
  resultEl.textContent = '';
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
    if (row.teamId === currentTeam.id) rowEl.classList.add('own-team');

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
}

function renderQuestion(q, socket) {
  // Keep the earlier question the player had expanded open across re-renders
  // (every host navigation sends a fresh 'question'); one mid-collapse doesn't count.
  const openIndexes = new Set(
    Array.from(quizEl.querySelectorAll('.previous-question[open]:not(.closing)')).map((d) =>
      Number(d.dataset.index)
    )
  );
  quizEl.innerHTML = '';

  const p = document.createElement('p');
  p.className = 'question-text';
  p.textContent = `${q.number} klausimas`;
  quizEl.appendChild(p);

  // Explicit index: a debounced typed answer can fire after the host has
  // already moved on, and must still land on the question it was typed for.
  renderAnswerInput(
    quizEl,
    q,
    (value) => socket.emit('select', value, q.index),
    (value) => socket.emit('select-bonus', value, q.index),
    (value) => lockAnswer(socket, value, q.index)
  );

  renderPreviousQuestions(q, socket, openIndexes);
}

// Already-shown questions of the current stage, collapsed by default. The
// player can expand any of them and change the pick until the stage ends —
// the server re-scores that question on each change.
function renderPreviousQuestions(q, socket, openIndexes) {
  const previous = q.previous || [];
  if (previous.length === 0) return;

  const section = document.createElement('div');
  section.className = 'previous-questions';

  const heading = document.createElement('p');
  heading.className = 'previous-questions-title';
  heading.textContent = 'Ankstesni šio etapo klausimai';
  section.appendChild(heading);

  previous.forEach((prev) => {
    const details = document.createElement('details');
    details.className = 'previous-question';
    details.dataset.index = prev.index;
    if (openIndexes.has(prev.index)) details.open = true;

    const summary = document.createElement('summary');
    summary.textContent = `${prev.number} klausimas`;
    const status = document.createElement('span');
    function showStatus(selection) {
      const answered = isAnswered(selection);
      status.className = 'previous-question-status' + (answered ? '' : ' unanswered');
      status.textContent = answered ? 'Atsakyta' : 'Neatsakyta';
    }
    showStatus(prev.mySelection);
    summary.appendChild(status);
    details.appendChild(summary);

    // body is what gets height-animated (clips); inner holds the padding.
    const body = document.createElement('div');
    body.className = 'previous-question-body';
    const inner = document.createElement('div');
    inner.className = 'previous-question-inner';
    body.appendChild(inner);
    details.appendChild(body);

    summary.addEventListener('click', (e) => {
      e.preventDefault(); // open/close ourselves so it can be animated
      if (details.open && !details.classList.contains('closing')) {
        collapseQuestion(details);
        return;
      }
      // Only one earlier question open at a time.
      section.querySelectorAll('.previous-question[open]').forEach((other) => {
        if (other !== details) collapseQuestion(other);
      });
      expandQuestion(details);
    });

    renderAnswerInput(
      inner,
      prev,
      (value) => {
        socket.emit('select', value, prev.index);
        showStatus(value);
      },
      (value) => socket.emit('select-bonus', value, prev.index),
      (value) => lockAnswer(socket, value, prev.index)
    );

    section.appendChild(details);
  });

  quizEl.appendChild(section);
}

const QUESTION_TOGGLE_MS = 250;

// Slides a previous question's body between its current height and target
// (a px value or 0), picking up mid-way if an earlier toggle is still running.
function animateQuestionBody(details, fromHeight, toHeight, onDone) {
  const body = details.querySelector('.previous-question-body');
  if (details._toggleAnim) details._toggleAnim.cancel();

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const anim = body.animate(
    [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
    { duration: reduceMotion ? 0 : QUESTION_TOGGLE_MS, easing: 'ease' }
  );
  details._toggleAnim = anim;
  anim.onfinish = () => {
    details._toggleAnim = null;
    onDone();
  };
}

function expandQuestion(details) {
  const body = details.querySelector('.previous-question-body');
  // Closed, the body isn't rendered; mid-collapse, start from where it is.
  const fromHeight = details.open ? body.getBoundingClientRect().height : 0;
  details.classList.remove('closing');
  details.open = true;
  animateQuestionBody(details, fromHeight, body.scrollHeight, () => {});
}

function collapseQuestion(details) {
  if (!details.open) return;
  const body = details.querySelector('.previous-question-body');
  details.classList.add('closing');
  animateQuestionBody(details, body.getBoundingClientRect().height, 0, () => {
    details.classList.remove('closing');
    details.open = false;
  });
}

// A pick is an option id or typed string — or, for a chain, one typed
// string per clue, answered once any of them is filled in.
function isAnswered(selection) {
  return Array.isArray(selection) ? selection.some((s) => s.length > 0) : selection.length > 0;
}

// A typed-answer question (textAnswer) gets an empty text field instead of
// option buttons — the server never sends it any options or the answer —
// or, with several answers to list, a field for each: numbered when they
// go in order, bulleted when any order will do. A chain gets one numbered
// field per clue (the clues themselves are only on the view screen). Several
// fields are sent together, in order. A question with an extra answer gets
// one more field under it, sent through onBonusChange.
function renderAnswerInput(container, q, onChange, onBonusChange, onLock) {
  if (q.type === 'chain') {
    renderTypedFields(container, q.linkCount, q.mySelection, true, onChange);
  } else if (q.textAnswer && q.answerCount > 1) {
    renderTypedFields(container, q.answerCount, q.mySelection, q.ordered, onChange);
  } else if (q.type === 'hints') {
    renderHintsAnswer(container, q, onChange, onLock);
  } else if (q.textAnswer) {
    container.appendChild(createTypedInput(q.mySelection || '', 'Įrašyk atsakymą', onChange));
  } else {
    renderOptions(container, q.options, q.mySelection || '', onChange, q.type === 'yesno');
  }

  if (q.hasBonus) {
    const label = document.createElement('p');
    label.className = 'bonus-answer-label';
    label.textContent = 'Papildomas atsakymas';
    container.appendChild(label);
    container.appendChild(createTypedInput(q.myBonus || '', 'Įrašyk papildomą atsakymą', onBonusChange));
  }
}

// Locks a hints question's answer in on the server — resolves with the
// points it was locked in for, or rejects with the reason it wasn't.
function lockAnswer(socket, value, index) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit('lock-answer', value, index, (err, res) => {
      if (err) reject(new Error('Nepavyko susisiekti su serveriu'));
      else if (!res || res.error) reject(new Error((res && res.error) || 'Nepavyko užrakinti'));
      else resolve(res.points);
    });
  });
}

// A hints question: the answer field and a button to lock it in, which
// asks once more (Atšaukti / Patvirtinti, side by side) before locking.
// What an answer is worth is only told once it's locked in — after that it
// can't be changed. (The hints themselves are only on the view screen.)
function renderHintsAnswer(container, q, onChange, onLock) {
  const wrap = document.createElement('div');
  wrap.className = 'hints-answer';
  container.appendChild(wrap);

  const input = createTypedInput(q.mySelection || '', 'Įrašyk atsakymą', onChange);
  wrap.appendChild(input);

  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'lock-answer-btn';
  lockBtn.textContent = 'Užrakinti atsakymą';

  const confirmRow = document.createElement('div');
  confirmRow.className = 'lock-confirm-row';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'lock-cancel-btn';
  cancelBtn.textContent = 'Atšaukti';
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'lock-confirm-btn';
  confirmBtn.textContent = 'Patvirtinti';
  confirmRow.append(cancelBtn, confirmBtn);

  const message = document.createElement('p');
  wrap.append(lockBtn, confirmRow, message);

  function showLocked(points) {
    input.disabled = true;
    lockBtn.remove();
    confirmRow.remove();
    message.className = 'hint-locked-message';
    message.textContent = `🔒 Atsakymas patvirtintas už ${points} tšk.`;
  }
  if (q.myLock != null) {
    showLocked(q.myLock);
    return;
  }

  function setConfirming(confirming) {
    lockBtn.hidden = confirming;
    confirmRow.hidden = !confirming;
    lockBtn.disabled = !input.value.trim();
    confirmBtn.disabled = false;
  }
  setConfirming(false);
  // A changed answer has to be locked in again.
  input.addEventListener('input', () => {
    message.textContent = '';
    setConfirming(false);
  });

  lockBtn.addEventListener('click', () => {
    message.textContent = '';
    setConfirming(true);
  });
  cancelBtn.addEventListener('click', () => setConfirming(false));
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      showLocked(await onLock(input.value.trim()));
    } catch (err) {
      setConfirming(false);
      message.className = 'hint-lock-error';
      message.textContent = err.message;
    }
  });
}

// count typed fields in a list, numbered (1., 2., …) or bulleted — every
// change sends all of them, one string each.
function renderTypedFields(container, count, selection, numbered, onChange) {
  const values = (selection || []).slice();
  const list = document.createElement('div');
  list.className = 'chain-answer-list';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('label');
    row.className = 'chain-answer-row';
    const number = document.createElement('span');
    number.className = 'chain-answer-number';
    number.textContent = numbered ? `${i + 1}.` : '•';
    row.appendChild(number);
    row.appendChild(
      createTypedInput(values[i] || '', 'Įrašyk atsakymą', (value) => {
        values[i] = value;
        onChange(Array.from({ length: count }, (_, j) => values[j] || ''));
      })
    );
    list.appendChild(row);
  }
  container.appendChild(list);
}

// Typing is sent after a short pause, and immediately when the field is left.
function createTypedInput(initialValue, placeholder, onChange) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-answer-input';
  input.placeholder = placeholder;
  input.maxLength = 200;
  input.autocomplete = 'off';
  input.value = initialValue;

  let lastSent = input.value;
  let timer = null;
  function send() {
    clearTimeout(timer);
    const value = input.value.trim();
    if (value === lastSent) return;
    lastSent = value;
    onChange(value);
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(send, 400);
  });
  input.addEventListener('change', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  return input;
}

// Renders one question's option buttons into container — one pick at a
// time, starting from selectedId — and reports every new pick (its option
// id) through onChange. Taip / Ne (yesNo) sit side by side.
function renderOptions(container, options, selectedId, onChange, yesNo) {
  const grid = document.createElement('div');
  grid.className = yesNo ? 'options-list yes-no-options' : 'options-list';
  container.appendChild(grid);

  options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.className = 'option';
    if (opt.id === selectedId) btn.classList.add('selected');
    btn.dataset.id = opt.id;

    // Picture options arrive as just a letter (the pictures themselves are
    // only on the view screen).
    btn.textContent = opt.label || opt.text;

    btn.addEventListener('click', () => {
      grid.querySelectorAll('.option').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      onChange(opt.id);
    });
    grid.appendChild(btn);
  });
}
