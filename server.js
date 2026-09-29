require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Adapters that are never the network players are on (VMs, WSL, Docker,
// the loopback adapter the hotspot script shares, Bluetooth).
const IGNORED_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|bluetooth/i;

// Every IPv4 address players could reach this machine at, best guess first:
// the Windows Mobile Hotspot's gateway (always 192.168.137.1) when the
// hotspot is on, then other private LAN addresses. Link-local (169.254.*)
// and virtual adapters are left out.
function lanAddressCandidates() {
  const found = [];
  for (const [adapter, addrs] of Object.entries(os.networkInterfaces())) {
    if (IGNORED_ADAPTER.test(adapter)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      if (!isPrivate) continue;
      found.push({ adapter, address: a.address });
    }
  }
  const rank = (c) => (c.address.startsWith('192.168.137.') ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b));
}

// The address players' phones reach the server at — LAN_IP from .env if set
// (to force one), otherwise detected fresh each time, so it's right on any
// computer and even if the hotspot is switched on after the server starts.
function lanIp() {
  if (process.env.LAN_IP) return process.env.LAN_IP;
  const [best] = lanAddressCandidates();
  return best ? best.address : 'localhost';
}

function joinUrl() {
  return `http://${lanIp()}:${PORT}/`;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const GAMES_FILE = path.join(__dirname, 'data', 'games.json');
const TEAMS_FILE = path.join(__dirname, 'data', 'teams.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

// data/ is gitignored and starts out empty on a fresh checkout: a missing
// file just means nothing saved yet, and both it and data/ itself get
// created on the first save. A file that exists but can't be read or
// parsed still stops the server — starting from {} would overwrite it on
// the next save and lose whatever it held.
function loadJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Nepavyko perskaityti ${path.relative(__dirname, file)}: ${err.message}`);
  }
}

function saveJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let games = loadJsonFile(GAMES_FILE);

function saveGames() {
  saveJsonFile(GAMES_FILE, games);
}

// Games saved before stages had ids get them once, on startup.
function ensureStageIds() {
  let changed = false;
  Object.values(games).forEach((game) => {
    const used = {};
    (game.stages || []).forEach((stage) => {
      const id = pickId(stage.id, used);
      if (id !== stage.id) {
        stage.id = id;
        changed = true;
      }
    });
  });
  if (changed) saveGames();
}

function loadTeams() {
  return loadJsonFile(TEAMS_FILE);
}

function saveTeams(teams) {
  saveJsonFile(TEAMS_FILE, teams);
}

// The season a new room is created under is a standing setting rather than
// something typed in every time — set once from the dashboard, it applies
// to every game hosted until changed again.
function loadSettings() {
  return loadJsonFile(SETTINGS_FILE);
}

function saveSettings(settings) {
  saveJsonFile(SETTINGS_FILE, settings);
}

// Turns an editor form submission ({ name, stages: [{ id?, name, questions:
// [{ id?, question, img, audio, audioStart, audioEnd, options: [{ id?, text,
// img }] }] }] }) into the games.json shape. The first option in the array
// is always taken as the correct answer (see the editor's createOptionRow).
//
// Ids are only ever created here, on the server — never by the GitHub Pages
// editor, whose files carry none. An id the submission already has (the
// editor sends back the ones of the game being edited, or of an imported
// file) is kept as long as it's well-formed and not already used within
// this game; anything else — a new stage/question/option, a duplicate, an
// id-less import — gets a fresh one, unique within the game. So editing
// never reshuffles ids, and a team's history (keyed by stage id) keeps
// pointing at the same stage even after it's renamed or moved.
function normalizeGamePayload(body) {
  const name = (body.name || '').trim();
  if (!name) return { error: 'Įvesk žaidimo pavadinimą' };
  if (!Array.isArray(body.stages) || body.stages.length === 0) {
    return { error: 'Pridėk bent vieną etapą' };
  }

  const stages = [];
  const usedStageIds = {};
  const usedQuestionIds = {};
  const usedOptionIds = {};

  for (const stage of body.stages) {
    const stageName = ((stage && stage.name) || '').trim();
    if (!stageName)
      return { error: 'Kiekvienas etapas turi turėti pavadinimą' };
    if (
      !stage ||
      !Array.isArray(stage.questions) ||
      stage.questions.length === 0
    ) {
      return { error: `Etapas "${stageName}" turi turėti bent vieną klausimą` };
    }
    const stageId = pickId(stage.id, usedStageIds);

    const questions = [];
    for (const q of stage.questions) {
      const questionText = ((q && q.question) || '').trim();
      if (!questionText)
        return { error: 'Kiekvienas klausimas turi turėti tekstą' };
      if (!q || !Array.isArray(q.options) || q.options.length < 1) {
        return {
          error: `Klausimas "${questionText}" turi turėti bent 1 atsakymo variantą (vienas = atsakymas įvedamas)`
        };
      }

      const authored = q.options.map((o) => ({
        id: o && o.id,
        text: ((o && o.text) || '').trim(),
        img: ((o && o.img) || '').trim()
      }));
      // A picture option has no text at all — the view screen and the
      // answers show it by its letter (A, B, C…), and any text it kept
      // (e.g. "Italija") would give the answer away, even as an alt. A
      // typed-answer question's single option is the answer to type,
      // though, so that one always has text.
      if (authored.length > 1) {
        authored.forEach((o) => {
          if (o.img) o.text = '';
        });
      }
      if (authored.length === 1 && !authored[0].text) {
        return {
          error: `Klausimas "${questionText}" turi turėti įrašytą teisingą atsakymą`
        };
      }
      if (authored.some((o) => !o.text && !o.img)) {
        return {
          error: `Klausimas "${questionText}" turi tuščią atsakymo variantą`
        };
      }
      // "media:..." points at a file kept in the GitHub Pages editor's
      // browser — it only works once imported from that editor's .zip export
      // (the file is uploaded then), never as-is.
      const mediaValues = [q.img, q.audio, ...authored.map((o) => o.img)];
      if (mediaValues.some((v) => typeof v === 'string' && v.startsWith('media:')))
        return {
          error: `Klausimas "${questionText}" nurodo failą, kurio nėra — importuok žaidimą iš .zip failo`
        };
      const questionId = pickId(q.id, usedQuestionIds);
      authored.forEach((o) => {
        o.id = pickId(o.id, usedOptionIds);
      });
      const answer = authored[0].id;

      // Stored in shuffled order so the file itself doesn't give away the
      // answer by position (display order is reshuffled per room anyway, in
      // createHistoryEntry). Fresh ids are random, so they don't either.
      const options = shuffle(authored).map((o) => {
        const option = { id: o.id, text: o.text };
        if (o.img) option.img = o.img;
        return option;
      });

      const question = {
        id: questionId,
        question: questionText,
        options,
        answer
      };
      const img = (q.img || '').trim();
      if (img) question.img = img;
      const audio = (q.audio || '').trim();
      if (audio) {
        question.audio = audio;
        const audioStart = Number(q.audioStart);
        const audioEnd = Number(q.audioEnd);
        if (Number.isFinite(audioStart) && audioStart > 0)
          question.audioStart = audioStart;
        if (Number.isFinite(audioEnd) && audioEnd > 0)
          question.audioEnd = audioEnd;
        if (
          question.audioEnd != null &&
          question.audioEnd <= (question.audioStart || 0)
        ) {
          return {
            error: `Klausimas "${questionText}" turi "iki" laiką didesnį už "nuo" laiką`
          };
        }
      }
      questions.push(question);
    }

    stages.push({ id: stageId, name: stageName, questions });
  }

  return { game: { name, stages } };
}

// Keeps a requested id if it's well-formed and not yet used (within the
// same game — see normalizeGamePayload); otherwise makes a fresh one that
// isn't. Either way the id is marked used.
function pickId(requested, used) {
  const id =
    typeof requested === 'string' &&
    /^[a-z0-9_]{1,24}$/.test(requested) &&
    !used[requested]
      ? requested
      : generateId(used);
  used[id] = true;
  return id;
}

// Any id a game can have — generated ones, and older/hand-made ones alike.
const GAME_ID_PATTERN = /^[a-z0-9_]{1,24}$/;

const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // be dviprasmiškų simbolių: i, l, o, 0, 1

function generateId(existingMap) {
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) {
      id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    }
  } while (existingMap[id]);
  return id;
}

ensureStageIds();

// Set HOST_CODE in a .env file (see .env.example) to pick your own fixed
// code; otherwise a fresh one is generated every time the server starts and
// printed below, in the listen() callback — anyone running the host control
// panel has to read it off this machine's own terminal, so a stranger on the
// same hotspot can't just guess their way into /host.
const HOST_CODE =
  process.env.HOST_CODE ||
  Array.from(
    { length: 8 },
    () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
  ).join('');
const HOST_COOKIE = 'host_auth';

function isHostAuthed(req) {
  const header = req.headers.cookie;
  if (!header) return false;
  return header.split(';').some((part) => {
    const [key, ...rest] = part.trim().split('=');
    return (
      key === HOST_COOKIE && decodeURIComponent(rest.join('=')) === HOST_CODE
    );
  });
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// roomId -> { name, gameId, stageIndex, questionIndex, questionHistory, phase, scores, leaderboard, stageReview }
// phase: 'game-intro' | 'stage-intro' | 'question' | 'stage-answers' | 'stage-results' | 'finished'
// game-intro is a one-time title slide with just the game's name, shown only
// once at the very start of a room, before the first stage-intro.
// stage-intro is a title slide ("Etapas 2 / 3: Muzikinis") shown before that
// stage's first question — both after game-intro and after each stage-results
// screen, before questionIndex/questionHistory reset into a fresh stage.
// questionHistory[i] holds { options, answer, img, audio, audioStart, audioEnd, selections,
// finalized, awardedPoints } for each question shown so far in the current stage, so the host
// can step back to an earlier question — with its exact shuffle and picks intact — and forward
// again without double-scoring (see navigateTo/finalizeEntry/unfinalizeEntry).
const rooms = {};

function generateRoomId() {
  let id;
  do {
    id = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms[id]);
  return id;
}

function currentStage(room) {
  return games[room.gameId].stages[room.stageIndex];
}

function publicQuestion(room, index = room.questionIndex) {
  const entry = room.questionHistory[index];
  return {
    question: currentStage(room).questions[index].question,
    options: entry.options,
    textAnswer: entry.textAnswer,
    img: entry.img,
    audio: entry.audio,
    audioStart: entry.audioStart,
    audioEnd: entry.audioEnd
  };
}

// Host-only: for each typed-answer question in the stage (keyed by its
// index), what every team typed and whether it currently counts — so the
// host can accept a misspelling or reject a lucky match. Every team that
// joined the room is listed, even with nothing typed: a team answering on
// paper still gets marked right by hand here (typing on a phone is the
// hard part; tapping an option isn't, so choice questions don't need this).
function typedAnswersForReview(room) {
  const teams = loadTeams();
  const out = {};
  room.questionHistory.forEach((entry, index) => {
    if (!entry || !entry.textAnswer) return;
    const teamIds = new Set([
      ...room.joinedTeams,
      ...Object.keys(entry.selections)
    ]);
    out[index] = Array.from(teamIds)
      .map((teamId) => {
        const typed = entry.selections[teamId];
        return {
          teamId,
          teamName: teams[teamId] ? teams[teamId].name : teamId,
          typed: typeof typed === 'string' ? typed.trim() : '',
          correct: isTypedAnswerCorrect(entry, teamId)
        };
      })
      .sort((a, b) => a.teamName.localeCompare(b.teamName, 'lt'));
  });
  return out;
}

function buildStageReview(room) {
  const stage = currentStage(room);
  return {
    stageName: stage.name,
    questions: stage.questions.map((q, i) => {
      const correctOption = q.options.find((o) => o.id === q.answer);
      // A picture option is named by the letter it had on the view screen
      // in this room (its shuffled order, kept in the history entry) — the
      // same A, B, C… players picked by, not the picture's file or text.
      const entry = room.questionHistory[i];
      const shownIndex = entry
        ? entry.options.findIndex((o) => o.id === q.answer)
        : -1;
      const correctAnswer =
        correctOption.img && shownIndex >= 0
          ? String.fromCharCode(65 + shownIndex)
          : correctOption.text || '—';
      return {
        number: i + 1,
        question: q.question,
        correctAnswer,
        img: resolveMediaSrc(q.img),
        correctAnswerImg: resolveMediaSrc(correctOption.img),
        audio: resolveMediaSrc(q.audio),
        audioStart: q.audioStart || null,
        audioEnd: q.audioEnd || null
      };
    })
  };
}

// Defaults to the running game totals; pass a stage's own scores to rank
// just what was earned in that stage.
function buildLeaderboard(room, scores = room.scores) {
  const teams = loadTeams();
  return Object.entries(scores)
    .map(([teamId, score]) => ({
      teamId,
      name: teams[teamId] ? teams[teamId].name : teamId,
      score
    }))
    .sort((a, b) => b.score - a.score);
}

// Adds a just-finished stage's scores onto each team's record, nested by
// season -> game -> stage id, so standings persist and can be broken down
// later. Keyed by stage id (not name) so two stages sharing a name never
// merge; the name is looked up from games.json when displayed (see
// stageDisplayName). Purely backend bookkeeping — never shown to clients.
function recordStageScores(room, stage, stageScores) {
  const label = `"${stage.name}" (${stage.id})`;
  if (!room.seasonId) {
    console.log(`[istorija] ${label}: kambarys be sezono, neįrašyta`);
    return;
  }
  const teams = loadTeams();
  const entries = Object.entries(stageScores);
  if (entries.length === 0)
    console.log(`[istorija] ${label}: nėra prisijungusių komandų`);
  entries.forEach(([teamId, score]) => {
    // Zero is still recorded (a team that played but scored nothing this
    // stage should still show up in its own history) — only an unknown
    // team (deleted mid-game) or a missing/NaN score is skipped.
    if (!teams[teamId] || typeof score !== 'number' || Number.isNaN(score)) {
      console.log(`[istorija] ${label}: praleista komanda ${teamId}`);
      return;
    }
    console.log(`[istorija] ${label}: ${teams[teamId].name} +${score}`);
    teams[teamId].seasons = teams[teamId].seasons || {};
    teams[teamId].seasons[room.seasonId] =
      teams[teamId].seasons[room.seasonId] || {};
    teams[teamId].seasons[room.seasonId][room.gameId] =
      teams[teamId].seasons[room.seasonId][room.gameId] || {};
    const gameStages = teams[teamId].seasons[room.seasonId][room.gameId];
    gameStages[stage.id] = (gameStages[stage.id] || 0) + score;
  });
  saveTeams(teams);
}

// History stores only stage ids; the name comes from games.json. Falls back
// to the key itself when the stage is gone (deleted from the game, or an
// old entry that was keyed by name).
function stageDisplayName(gameId, stageKey) {
  const game = games[gameId];
  const stage = game && game.stages.find((s) => s.id === stageKey);
  return stage ? stage.name : stageKey;
}

// Each team's total across every game and stage recorded under a season
// (see recordStageScores), ranked for the end-of-game season standings.
// Teams in this room always show up, even with nothing recorded yet (0).
function buildSeasonLeaderboard(room) {
  const seasonId = room.seasonId;
  const teams = loadTeams();
  return Object.entries(teams)
    .filter(
      ([teamId, t]) =>
        (t.seasons && t.seasons[seasonId]) || room.joinedTeams.has(teamId)
    )
    .map(([teamId, t]) => ({
      teamId,
      name: t.name,
      score: Object.values((t.seasons && t.seasons[seasonId]) || {}).reduce(
        (sum, stages) =>
          sum +
          Object.values(stages).reduce((s, score) => s + score, 0),
        0
      )
    }))
    .sort((a, b) => b.score - a.score);
}

// What the finished screen shows: this game's totals, or — once the host
// toggles to them — the whole active season's standings.
function finalLeaderboardPayload(room) {
  return room.showSeason
    ? {
        rows: buildSeasonLeaderboard(room),
        final: true,
        seasonId: room.seasonId
      }
    : { rows: room.leaderboard, final: true };
}

// A question authored with a single option is a typed-answer question: that
// option's text is the answer, so it's kept only in correctText (server-side)
// and options stays empty — publicQuestion/otherShownQuestions send options
// as-is, so nothing about the answer ever reaches a player or view screen.
function isTextAnswerQuestion(q) {
  return q.options.length === 1;
}

// Lenient comparison for typed answers: case, Lithuanian diacritics,
// punctuation and extra spaces don't matter ("Vilnius!" == " vilnius").
function normalizeTypedAnswer(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function createHistoryEntry(q) {
  const textAnswer = isTextAnswerQuestion(q);
  return {
    options: textAnswer
      ? []
      : shuffle(q.options).map((o) =>
          // text dropped here too, for games saved before picture options
          // lost theirs (see normalizeGamePayload) — this is what the view
          // screen gets
          o.img ? { id: o.id, text: '', img: resolveMediaSrc(o.img) } : o
        ),
    textAnswer,
    correctText: textAnswer ? q.options[0].text : null,
    answer: q.answer,
    img: resolveMediaSrc(q.img),
    audio: q.audio || null,
    audioStart: q.audioStart || null,
    audioEnd: q.audioEnd || null,
    selections: {},
    // Typed-answer only: the host's manual correct/incorrect call per team
    // (from the stage-answers review), overriding the automatic match.
    textOverrides: {},
    finalized: false,
    awardedPoints: {}
  };
}

// Whether a team's typed answer counts: the host's call if they made one,
// otherwise the lenient automatic match (see normalizeTypedAnswer).
function isTypedAnswerCorrect(entry, teamId) {
  if (teamId in entry.textOverrides) return entry.textOverrides[teamId];
  const typed = entry.selections[teamId];
  if (typeof typed !== 'string') return false;
  const normalized = normalizeTypedAnswer(typed);
  // Blank (or punctuation-only) never matches.
  return (
    normalized !== '' &&
    normalized === normalizeTypedAnswer(entry.correctText)
  );
}

// Scores whoever answered the question, using the last pick each team sent:
// 1 point for the correct option (or, for a typed-answer question, a match —
// see normalizeTypedAnswer), 0 otherwise. Records what was awarded per team so
// unfinalizeEntry can reverse it exactly if the host steps back to this question.
function finalizeEntry(room, index) {
  const entry = room.questionHistory[index];
  if (!entry || entry.finalized) return;
  const awarded = {};

  if (entry.textAnswer) {
    // Teams the host marked by hand count too, typed or not (paper answers).
    const teamIds = new Set([
      ...Object.keys(entry.selections),
      ...Object.keys(entry.textOverrides)
    ]);
    teamIds.forEach((teamId) => {
      if (!isTypedAnswerCorrect(entry, teamId)) return;
      awarded[teamId] = 1;
      room.scores[teamId] = (room.scores[teamId] || 0) + 1;
    });
    entry.awardedPoints = awarded;
    entry.finalized = true;
    return;
  }

  Object.entries(entry.selections).forEach(([teamId, selected]) => {
    if (selected !== entry.answer) return;
    awarded[teamId] = 1;
    room.scores[teamId] = (room.scores[teamId] || 0) + 1;
  });

  entry.awardedPoints = awarded;
  entry.finalized = true;
}

function unfinalizeEntry(room, index) {
  const entry = room.questionHistory[index];
  if (!entry || !entry.finalized) return;
  Object.entries(entry.awardedPoints).forEach(([teamId, points]) => {
    room.scores[teamId] = (room.scores[teamId] || 0) - points;
  });
  entry.awardedPoints = {};
  entry.finalized = false;
}

// The furthest question shown so far in the current stage. Players always
// get this one as their main question — even while the host has stepped back
// to an earlier one on the view screen — so teams answering at different
// paces don't get their main question swapped out from under them.
function latestShownIndex(room) {
  return room.questionHistory.length - 1;
}

// Every other question already shown in the current stage, with this team's
// pick for each — lets the player expand them and still change an answer
// until the stage ends (see the 'select' handler's index argument).
// Picture options never reach players' phones — only a letter (A, B, C…)
// matching the one the view screen draws on each picture — so a phone
// can't just feed the image to an AI. Its text (e.g. "Italija") would give
// the answer away just the same, so that's left out too.
function optionsForPlayer(options) {
  return options.map((o, i) =>
    o.img
      ? { id: o.id, label: String.fromCharCode(65 + i) }
      : { id: o.id, text: o.text }
  );
}

function otherShownQuestions(room, teamId, mainIndex) {
  const out = [];
  room.questionHistory.forEach((entry, index) => {
    if (!entry || index === mainIndex) return;
    out.push({
      index,
      number: index + 1,
      options: optionsForPlayer(entry.options),
      textAnswer: entry.textAnswer,
      mySelection: mySelectionFor(entry, teamId)
    });
  });
  return out;
}

// A team's current pick: the option id for a choice question, the typed
// string for a typed-answer one ('' if nothing yet).
function mySelectionFor(entry, teamId) {
  const value = teamId && entry.selections[teamId];
  return typeof value === 'string' ? value : '';
}

// A team (player) gets the latest shown question plus all the others to
// revisit; the view screen (no teamId) gets whatever the host is on now.
function questionPayloadFor(room, teamId) {
  if (!teamId) {
    return {
      ...publicQuestion(room),
      index: room.questionIndex,
      number: room.questionIndex + 1
    };
  }
  const mainIndex = latestShownIndex(room);
  const entry = room.questionHistory[mainIndex];
  return {
    ...publicQuestion(room, mainIndex),
    options: optionsForPlayer(entry.options),
    // The question itself — its text, picture and music — is only on the
    // view screen; phones just get "Klausimas N", so there's nothing to
    // paste into an AI or feed to Google Lens / Shazam.
    question: null,
    img: null,
    audio: null,
    audioStart: null,
    audioEnd: null,
    index: mainIndex,
    number: mainIndex + 1,
    mySelection: mySelectionFor(entry, teamId),
    previous: otherShownQuestions(room, teamId, mainIndex)
  };
}

// Sends each connected team its own picks (rather than one broadcast for
// everyone). Players only need a fresh copy when a new question has been
// shown — stepping back and forth through already-shown questions changes
// nothing on their side, and re-rendering would just wipe a half-typed answer.
function broadcastQuestion(room, roomId, playersToo) {
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.roomId !== roomId) continue;
    if (socket.data.teamId && !playersToo) continue;
    socket.emit('question', questionPayloadFor(room, socket.data.teamId));
  }
}

// Moves the host to targetIndex within the current stage, in either direction.
// Finalizes (scores) the question being left, and reopens the target question —
// restoring its exact shuffle and each team's prior picks, undoing its score if
// it had already been finalized — so re-visited questions can be answered again
// without double-counting points.
function navigateTo(room, roomId, targetIndex) {
  const stage = currentStage(room);
  if (targetIndex < 0 || targetIndex >= stage.questions.length) return false;

  if (room.questionIndex >= 0) finalizeEntry(room, room.questionIndex);

  const entry = room.questionHistory[targetIndex];
  if (entry) {
    if (entry.finalized) unfinalizeEntry(room, targetIndex);
  } else {
    room.questionHistory[targetIndex] = createHistoryEntry(
      stage.questions[targetIndex]
    );
  }

  room.questionIndex = targetIndex;
  broadcastQuestion(room, roomId, !entry);
  return true;
}

// The dev room plays "QuickTest" — the game covering every question type
// (text, typed answer, music, picture question, picture options) — falling
// back to the first game if it's been deleted.
const DEV_GAME_ID = 'c6vh22';

if (['dev', 'dev:server'].includes(process.env.npm_lifecycle_event)) {
  const defaultGameId = games[DEV_GAME_ID]
    ? DEV_GAME_ID
    : Object.keys(games)[0];
  if (defaultGameId) {
    rooms['000000'] = {
      name: games[defaultGameId].name,
      gameId: defaultGameId,
      seasonId: loadSettings().activeSeason || null,
      stageIndex: 0,
      questionIndex: -1,
      questionHistory: [],
      phase: 'game-intro',
      scores: {},
      priorScores: {},
      joinedTeams: new Set(),
      internetStatus: {},
      internetWarning: false,
      leaderboard: null,
      stageReview: null
    };
    console.log('Dev mode: default room 000000 created');
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// JSZip for the game editor's .zip import (see public/game-media-zip.js).
app.get('/vendor/jszip.min.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'jszip', 'dist', 'jszip.min.js'))
);
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-store')
  })
);

// Gate every host page and host/game-management API behind the terminal-
// printed HOST_CODE. /api/local-audio is deliberately excluded — view
// screens and player phones fetch music through it during actual play.
app.use((req, res, next) => {
  const isHostPage = req.path === '/host' || req.path.startsWith('/host/');
  const isHostApi =
    req.path.startsWith('/api/host/') || req.path.startsWith('/api/games');
  if (!isHostPage && !isHostApi) return next();
  if (req.path === '/host/login') return next();
  if (isHostAuthed(req)) return next();
  if (isHostApi)
    return res.status(401).json({ error: 'Reikalingas prieigos kodas' });
  res.redirect('/host/login?next=' + encodeURIComponent(req.originalUrl));
});

app.get('/host/login', (req, res) => {
  res.render('host/login', {
    title: 'Quiz - Host prisijungimas',
    error: null,
    next: req.query.next || '/host'
  });
});

app.post('/host/login', (req, res) => {
  const code = (req.body.code || '').trim();
  // Must be a same-site relative path — otherwise ?next= could redirect
  // a logged-in host anywhere (e.g. next=https://evil.example).
  const rawNext = req.body.next || '';
  const next =
    rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/host';
  if (code !== HOST_CODE) {
    return res
      .status(401)
      .render('host/login', {
        title: 'Quiz - Host prisijungimas',
        error: 'Neteisingas kodas',
        next
      });
  }
  res.cookie(HOST_COOKIE, HOST_CODE, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000
  });
  res.redirect(next);
});

app.post('/host/logout', (req, res) => {
  res.clearCookie(HOST_COOKIE);
  res.redirect('/host/login');
});

const LOCAL_MEDIA_MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function localPathKey(filePath) {
  return path.resolve(filePath).toLowerCase();
}

// Every local file path some game points at (question/option pictures and
// question music) — the only files /api/local-audio hands out to non-hosts.
function referencedLocalPaths() {
  const out = new Set();
  const add = (value) => {
    if (value && !/^https?:[/][/]/i.test(value) && !value.startsWith('/'))
      out.add(localPathKey(value));
  };
  Object.values(games).forEach((game) =>
    game.stages.forEach((stage) =>
      stage.questions.forEach((q) => {
        add(q.img);
        add(q.audio);
        q.options.forEach((o) => add(o.img));
      })
    )
  );
  return out;
}

// Streams a local picture or audio file (by absolute path, e.g.
// "C:\Users\...\song.mp3") from this machine's disk over HTTP, with Range
// support so <audio> can seek/scrub. This is what makes a plain local file
// path work in a picture/audio field — the server (running on the host's own
// PC) reads the bytes; browsers can't reach a local filesystem path directly.
// resolveMediaSrc() below, and its client-side mirrors (view.js,
// game-editor-core.js), route anything but a URL/app-relative path here.
// Every phone on the hotspot can reach this, so it never serves an arbitrary
// file (e.g. .env): only picture/audio types, and — for anyone but the host,
// whose editor previews files before they're saved — only ones a game uses.
app.get('/api/local-audio', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string') return res.status(400).end();
  const contentType =
    LOCAL_MEDIA_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  if (!contentType) return res.status(404).end();
  if (!isHostAuthed(req) && !referencedLocalPaths().has(localPathKey(filePath)))
    return res.status(404).end();

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return res.status(404).end();
  }
  if (!stat.isFile()) return res.status(404).end();

  res.set('Content-Type', contentType);
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'no-store');

  const range = req.headers.range;
  if (!range) {
    res.set('Content-Length', stat.size);
    return fs.createReadStream(filePath).pipe(res);
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.set('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// Pictures and music picked from the computer in the game editor (📁), and
// the files inside an imported .zip, are uploaded here — a browser never
// reveals a picked file's real path, so it can't just be typed in. Each
// game's files go in their own folder, data/media/<game id>/ (the editor
// sends the id as ?gameId=; a new game's is reserved when its editor page
// opens, see /host/games/new), served at /media/<game id>/<file>; uploads
// without an id land in data/media/ itself, as older ones did. Named after
// a hash of the content, so uploading the same file twice keeps one copy.
// Not host-gated: the view screen loads them during play.
const MEDIA_DIR = path.join(__dirname, 'data', 'media');
const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const MEDIA_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/webm': '.webm'
};

app.use(
  '/media',
  express.static(MEDIA_DIR, { maxAge: '365d', immutable: true, index: false })
);

app.post(
  '/api/host/upload',
  express.raw({ type: () => true, limit: MEDIA_MAX_BYTES }),
  (req, res) => {
    const type = (req.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const ext = MEDIA_EXTENSIONS[type];
    if (!ext)
      return res
        .status(400)
        .json({ error: 'Galima įkelti tik nuotraukas ir garso failus' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'Failas tuščias' });

    // Same shape as the ids generateId makes — and never anything that
    // could climb out of MEDIA_DIR.
    const gameId = req.query.gameId;
    const folder =
      typeof gameId === 'string' && GAME_ID_PATTERN.test(gameId) ? gameId : null;
    const dir = folder ? path.join(MEDIA_DIR, folder) : MEDIA_DIR;

    const hash = crypto.createHash('sha1').update(req.body).digest('hex');
    const fileName = hash.slice(0, 16) + ext;
    const filePath = path.join(dir, fileName);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, req.body);
    } catch (err) {
      return res.status(500).json({ error: 'Nepavyko išsaugoti failo' });
    }
    res.json({ url: folder ? `/media/${folder}/${fileName}` : `/media/${fileName}` });
  }
);

// Oversized uploads (see MEDIA_MAX_BYTES) get a readable message.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large')
    return res.status(413).json({ error: 'Failas per didelis (daugiausia 100 MB)' });
  next(err);
});

// The game editor's 📁 button can open a real Windows file dialog — and so
// fill in the file's actual path (e.g. C:Users...song.mp3), which a
// browser file picker never reveals — but the dialog pops up on the screen
// of the computer running this server. So only when the editor is opened on
// that same computer (Windows only); anywhere else the file gets uploaded.
function canUseNativeFilePicker(req) {
  if (process.platform !== 'win32') return false;
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (remote === '127.0.0.1' || remote === '::1') return true;
  return Object.values(os.networkInterfaces()).some((addrs) =>
    (addrs || []).some((a) => a.address === remote)
  );
}

const FILE_DIALOG_FILTERS = {
  image: 'Nuotraukos|*.jpg;*.jpeg;*.png;*.gif;*.webp;*.svg',
  audio: 'Garso failai|*.mp3;*.wav;*.ogg;*.m4a;*.aac;*.flac'
};

// Opens the Windows "Open file" dialog (topmost, so it isn't hidden behind
// the browser) and resolves with the picked path, or null if cancelled.
function showWindowsFileDialog(kind) {
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Filter = '${FILE_DIALOG_FILTERS[kind]}|Visi failai|*.*'`,
    "$dialog.Title = 'Pasirinkite failą'",
    "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.FileName) }",
    '$owner.Dispose()'
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 10 * 60 * 1000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim() || null))
    );
  });
}

app.post('/api/host/pick-file', async (req, res) => {
  const kind = req.body && req.body.kind;
  if (!FILE_DIALOG_FILTERS[kind])
    return res.status(400).json({ error: 'Netinkamas failo tipas' });
  if (!canUseNativeFilePicker(req))
    return res
      .status(400)
      .json({ error: 'Failo langą galima atidaryti tik serverio kompiuteryje' });
  try {
    res.json({ path: await showWindowsFileDialog(kind) });
  } catch (err) {
    res.status(500).json({ error: 'Nepavyko atidaryti failo pasirinkimo lango' });
  }
});

// A picture or audio field can hold a full URL, an app-relative path
// (/media/...), or a raw local filesystem path picked in the editor — this
// turns any of those into something a browser can use as a src.
function resolveMediaSrc(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return value;
  return `/api/local-audio?path=${encodeURIComponent(value)}`;
}

function renderHostDashboard(req, res, error) {
  const gameList = Object.keys(games).map((id) => ({
    id,
    name: games[id].name
  }));
  const roomList = Object.keys(rooms).map((id) => ({
    id,
    name: rooms[id].name
  }));
  res.render('host/dashboard', {
    title: 'Quiz - Host',
    gameList,
    roomList,
    activeSeason: loadSettings().activeSeason || null,
    error: error || null
  });
}

function renderHostRoom(req, res, roomId) {
  const room = rooms[roomId];
  const game = games[room.gameId];
  const stage = currentStage(room);
  const isLastStage = room.stageIndex === game.stages.length - 1;

  if (room.phase === 'game-intro') {
    return res.render('host/game-intro', {
      title: 'Quiz - Host',
      roomId,
      roomName: room.name
    });
  }

  if (room.phase === 'stage-intro') {
    return res.render('host/stage-intro', {
      title: 'Quiz - Host',
      roomId,
      roomName: room.name,
      stageName: stage.name,
      stageNumber: room.stageIndex + 1,
      stageCount: game.stages.length
    });
  }

  if (room.phase === 'stage-answers') {
    return res.render('host/stage-answers', {
      title: 'Quiz - Host',
      roomId,
      roomName: room.name,
      review: room.stageReview,
      typedAnswers: typedAnswersForReview(room)
    });
  }

  if (room.phase === 'stage-results') {
    return res.render('host/stage-results', {
      title: 'Quiz - Host',
      roomId,
      roomName: room.name,
      stageName: stage.name,
      stageNumber: room.stageIndex + 1,
      stageCount: game.stages.length,
      isLastStage,
      leaderboard: room.leaderboard
    });
  }

  const hasMore = room.questionIndex + 1 < stage.questions.length;
  const hasPrevious = room.questionIndex > 0;
  const currentQuestion =
    room.questionIndex >= 0 ? stage.questions[room.questionIndex] : null;
  const currentEntry =
    room.questionIndex >= 0 ? room.questionHistory[room.questionIndex] : null;
  res.render('host/room', {
    title: 'Quiz - Host',
    roomId,
    roomName: room.name,
    gameName: game.name,
    stageName: stage.name,
    stageNumber: room.stageIndex + 1,
    stageCount: game.stages.length,
    currentQuestionText: currentQuestion ? currentQuestion.question : null,
    currentQuestionNumber: room.questionIndex + 1,
    currentQuestionAudio: currentQuestion
      ? resolveMediaSrc(currentQuestion.audio)
      : null,
    currentQuestionAudioStart: currentQuestion
      ? currentQuestion.audioStart || null
      : null,
    currentQuestionAudioEnd: currentQuestion
      ? currentQuestion.audioEnd || null
      : null,
    currentQuestionImg: currentQuestion ? resolveMediaSrc(currentQuestion.img) : null,
    currentQuestionTextAnswer: currentQuestion
      ? isTextAnswerQuestion(currentQuestion)
      : false,
    // Taken from the room's history entry, not the stored question — that
    // entry holds this room's shuffled order, the one players and the view
    // screen actually see, so the fullscreen grid matches it.
    currentQuestionOptionImages:
      currentEntry &&
      currentEntry.options.length > 0 &&
      currentEntry.options.every((o) => o.img)
        ? currentEntry.options.map((o) => ({ src: o.img }))
        : null,
    hasMore,
    hasPrevious
  });
}

function renderLeaderboard(req, res, roomId) {
  const room = rooms[roomId];
  res.render('host/leaderboard', {
    title: 'Quiz - Rezultatai',
    roomId,
    roomName: room.name,
    leaderboard: finalLeaderboardPayload(room).rows,
    seasonId: room.seasonId,
    showSeason: !!room.showSeason
  });
}

// Every open room, for the lists the view screen and players pick from.
function activeRoomList() {
  return Object.keys(rooms).map((id) => ({
    id,
    name: rooms[id].name
  }));
}

function renderViewDashboard(req, res, error) {
  res.render('view/dashboard', {
    title: 'Quiz - View',
    roomList: activeRoomList(),
    error: error || null
  });
}

// Players pick their room from the same list the view screen shows, once
// their team is set (see room.js) — no code to type.
function renderPlayerJoin(res, error) {
  res.render('player/join', {
    title: 'Quiz',
    roomList: activeRoomList(),
    error: error || null
  });
}

app.get('/', (req, res) => {
  renderPlayerJoin(res);
});

app.get('/host', (req, res) => {
  renderHostDashboard(req, res);
});

app.get('/host/games', (req, res) => {
  const gameList = Object.entries(games).map(([id, g]) => ({
    id,
    name: g.name,
    stageCount: g.stages.length,
    questionCount: g.stages.reduce((n, s) => n + s.questions.length, 0)
  }));
  res.render('host/games', { title: 'Quiz - Žaidimai', gameList, error: null });
});

// Regroups each team's seasons -> game -> stage breakdown (see
// recordStageScores) by season: newest (highest number) season first, and in
// each one its teams ranked by that season's total, with a total per game so
// the page doesn't have to re-sum on every render.
app.get('/host/teams', (req, res) => {
  const teams = loadTeams();
  const seasonsById = {};
  let teamCount = 0;

  Object.entries(teams).forEach(([id, t]) => {
    teamCount++;
    Object.entries(t.seasons || {}).forEach(([seasonId, gamesForSeason]) => {
      const gameList = Object.entries(gamesForSeason).map(
        ([gameId, stageScores]) => {
          const stageList = Object.entries(stageScores).map(
            ([stageKey, score]) => ({
              stageName: stageDisplayName(gameId, stageKey),
              score
            })
          );
          return {
            gameId,
            gameName: games[gameId] ? games[gameId].name : gameId,
            stages: stageList,
            total: stageList.reduce((sum, s) => sum + s.score, 0)
          };
        }
      );
      seasonsById[seasonId] = seasonsById[seasonId] || [];
      seasonsById[seasonId].push({
        id,
        name: t.name,
        games: gameList,
        total: gameList.reduce((sum, g) => sum + g.total, 0)
      });
    });
  });

  const seasonList = Object.entries(seasonsById)
    .map(([seasonId, seasonTeams]) => ({
      seasonId,
      teams: seasonTeams.sort(
        (a, b) => b.total - a.total || a.name.localeCompare(b.name, 'lt')
      )
    }))
    .sort((a, b) => b.seasonId.localeCompare(a.seasonId, undefined, { numeric: true }));

  res.render('host/teams', {
    title: 'Quiz - Komandų istorija',
    seasonList,
    teamCount,
    error: null
  });
});

app.get('/host/games/new', (req, res) => {
  res.render('host/game-editor', {
    title: 'Quiz - Naujas žaidimas',
    gameId: null,
    // Reserved now so files uploaded before the first save (📁, a .zip
    // import) already go in this game's media folder; POST /api/games
    // then saves the game under it.
    newGameId: generateId(games),
    game: null,
    nativeFilePicker: canUseNativeFilePicker(req)
  });
});

app.get('/host/games/:gameId/edit', (req, res) => {
  const game = games[req.params.gameId];
  if (!game) {
    const gameList = Object.entries(games).map(([id, g]) => ({
      id,
      name: g.name,
      stageCount: g.stages.length,
      questionCount: g.stages.reduce((n, s) => n + s.questions.length, 0)
    }));
    return res
      .status(404)
      .render('host/games', {
        title: 'Quiz - Žaidimai',
        gameList,
        error: 'Žaidimas nerastas'
      });
  }
  res.render('host/game-editor', {
    title: 'Quiz - Redaguoti žaidimą',
    gameId: req.params.gameId,
    newGameId: null,
    game,
    nativeFilePicker: canUseNativeFilePicker(req)
  });
});

app.get('/host/:roomId(\\d{6})', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return renderHostDashboard(req, res, 'Kambarys nerastas');
  if (room.phase === 'finished') return renderLeaderboard(req, res, roomId);
  return renderHostRoom(req, res, roomId);
});

app.get('/view', (req, res) => {
  renderViewDashboard(req, res);
});

// QR code for the player join page, shown on the view dashboard so people
// can scan it with their phone instead of typing the hotspot IP in by hand.
app.get('/api/qr', (req, res) => {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'no-store');
  QRCode.toString(joinUrl(), { type: 'svg', margin: 1 }, (err, svg) => {
    if (err) return res.status(500).end();
    res.send(svg);
  });
});

app.get('/view/:roomId(\\d{6})', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return renderViewDashboard(req, res, 'Kambarys nerastas');
  res.render('view/screen', {
    title: 'Quiz - View',
    roomId,
    roomName: room.name
  });
});

app.get('/:roomId(\\d{6})', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room)
    return renderPlayerJoin(res.status(404), 'Kambarys nerastas');
  res.render('player/play', { title: 'Quiz', roomId });
});

app.get('/api/games/:gameId', (req, res) => {
  const game = games[req.params.gameId];
  if (!game) return res.status(404).json({ error: 'Žaidimas nerastas' });
  res.json({ id: req.params.gameId, ...game });
});

app.post('/api/games', (req, res) => {
  const result = normalizeGamePayload(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  // The id the new-game editor reserved (its uploads are already in that
  // media folder) — unless it's malformed or got taken in the meantime.
  const requested = req.body && req.body.id;
  const gameId =
    typeof requested === 'string' &&
    GAME_ID_PATTERN.test(requested) &&
    !games[requested]
      ? requested
      : generateId(games);
  games[gameId] = result.game;
  saveGames();
  res.json({ gameId });
});

app.put('/api/games/:gameId', (req, res) => {
  const gameId = req.params.gameId;
  if (!games[gameId])
    return res.status(404).json({ error: 'Žaidimas nerastas' });
  const result = normalizeGamePayload(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  games[gameId] = result.game;
  saveGames();
  res.json({ ok: true });
});

app.delete('/api/games/:gameId', (req, res) => {
  const gameId = req.params.gameId;
  if (!games[gameId])
    return res.status(404).json({ error: 'Žaidimas nerastas' });
  const inUse = Object.values(rooms).some((r) => r.gameId === gameId);
  if (inUse)
    return res
      .status(400)
      .json({ error: 'Žaidimas naudojamas aktyviame kambaryje' });
  delete games[gameId];
  saveGames();
  res.json({ ok: true });
});

app.post('/api/host/room', (req, res) => {
  const gameId = req.body.gameId;
  if (!games[gameId])
    return res.status(400).json({ error: 'Pasirink žaidimą' });

  const seasonId = loadSettings().activeSeason || null;

  const roomId = generateRoomId();
  rooms[roomId] = {
    name: games[gameId].name,
    gameId,
    seasonId,
    stageIndex: 0,
    questionIndex: -1,
    questionHistory: [],
    phase: 'game-intro',
    scores: {},
    priorScores: {},
    joinedTeams: new Set(),
    internetStatus: {},
    internetWarning: false,
    leaderboard: null,
    stageReview: null
  };
  res.json({ roomId });
});

app.post('/api/host/season', (req, res) => {
  const season = (req.body.season || '').toString().trim() || null;
  const settings = loadSettings();
  settings.activeSeason = season;
  saveSettings(settings);
  // Rooms that haven't started yet (e.g. the long-lived dev room) pick up
  // the new season; ones already mid-game keep the season they began under.
  Object.values(rooms).forEach((room) => {
    if (room.phase === 'game-intro') room.seasonId = season;
  });
  res.json({ activeSeason: settings.activeSeason });
});

// Stage-answers review: the host marks a team's typed answer right or wrong
// by hand (e.g. a typo), re-scoring that question for everyone. Only until
// the host moves on — the stage's points are recorded right after.
app.post('/api/host/room/:roomId/typed-answer', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  if (room.phase !== 'stage-answers')
    return res
      .status(400)
      .json({ error: 'Vertinti galima tik rodant etapo atsakymus' });
  const { index, teamId, correct } = req.body || {};
  const entry = Number.isInteger(index) && room.questionHistory[index];
  // Any team in the room — one that typed nothing (answered on paper) can
  // still be marked right.
  if (
    !entry ||
    !entry.textAnswer ||
    typeof teamId !== 'string' ||
    !(room.joinedTeams.has(teamId) || teamId in entry.selections)
  )
    return res.status(400).json({ error: 'Atsakymas nerastas' });

  unfinalizeEntry(room, index);
  entry.textOverrides[teamId] = !!correct;
  finalizeEntry(room, index);
  res.json({ correct: isTypedAnswerCorrect(entry, teamId) });
});

app.post('/api/host/room/:roomId/prev', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  if (room.phase !== 'question') {
    return res
      .status(400)
      .json({ error: 'Grįžti atgal galima tik klausimų rodymo metu' });
  }
  if (!navigateTo(room, roomId, room.questionIndex - 1)) {
    return res.status(400).json({ error: 'Tai pirmas etapo klausimas' });
  }
  res.json({ phase: 'question' });
});

app.post('/api/host/room/:roomId/next', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  const game = games[room.gameId];

  if (room.phase === 'game-intro') {
    room.phase = 'stage-intro';
    io.to(roomId).emit('stage-intro', {
      stageName: currentStage(room).name,
      stageNumber: room.stageIndex + 1,
      stageCount: game.stages.length
    });
    return res.json({ phase: 'stage-intro' });
  }

  if (room.phase === 'question') {
    if (navigateTo(room, roomId, room.questionIndex + 1))
      return res.json({ phase: 'question' });

    finalizeEntry(room, room.questionIndex);
    room.phase = 'stage-answers';
    room.stageReview = buildStageReview(room);
    io.to(roomId).emit('stage-answers', room.stageReview);
    return res.json({ phase: 'stage-answers' });
  }

  if (room.phase === 'stage-answers') {
    // Every team that connected to the room, not just ones with a
    // non-zero score — otherwise a team that played but answered
    // everything wrong (0 points) never shows up in its own history.
    const stageScores = {};
    room.joinedTeams.forEach((teamId) => {
      stageScores[teamId] =
        (room.scores[teamId] || 0) - (room.priorScores[teamId] || 0);
    });
    recordStageScores(room, currentStage(room), stageScores);
    room.priorScores = { ...room.scores };

    room.phase = 'stage-results';
    room.leaderboard = buildLeaderboard(room, stageScores);
    io.to(roomId).emit('leaderboard', {
      rows: room.leaderboard,
      final: false,
      stageName: currentStage(room).name
    });
    return res.json({ phase: 'stage-results' });
  }

  if (room.phase === 'stage-results') {
    room.stageIndex++;
    room.questionIndex = -1;
    room.questionHistory = [];

    if (room.stageIndex >= game.stages.length) {
      room.phase = 'finished';
      // Every team that joined shows up, even with 0 points — same as the
      // per-stage leaderboards.
      const finalScores = {};
      room.joinedTeams.forEach((teamId) => {
        finalScores[teamId] = 0;
      });
      Object.assign(finalScores, room.scores);
      room.leaderboard = buildLeaderboard(room, finalScores);
      room.showSeason = false;
      io.to(roomId).emit('leaderboard', finalLeaderboardPayload(room));
      return res.json({ phase: 'finished' });
    }

    room.phase = 'stage-intro';
    io.to(roomId).emit('stage-intro', {
      stageName: currentStage(room).name,
      stageNumber: room.stageIndex + 1,
      stageCount: game.stages.length
    });
    return res.json({ phase: 'stage-intro' });
  }

  if (room.phase === 'stage-intro') {
    room.phase = 'question';
    navigateTo(room, roomId, 0);
    return res.json({ phase: 'question' });
  }

  res.status(400).json({ error: 'Žaidimas jau baigtas' });
});

// The "turn off mobile data" overlay on players' phones — off by default,
// switched off/on by the host at any point (e.g. while testing with phones
// that have no way to go offline). Phones keep checking and reporting
// either way, so the host's team list still shows who's online.
app.post('/api/host/room/:roomId/internet-warning-toggle', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  room.internetWarning = !room.internetWarning;
  io.to(roomId).emit('internet-warning', { enabled: room.internetWarning });
  io.to(hostWatchChannel(roomId)).emit('internet-warning', {
    enabled: room.internetWarning
  });
  res.json({ enabled: room.internetWarning });
});

// Finished screen: flips every screen between this game's totals and the
// active season's standings.
app.post('/api/host/room/:roomId/season-toggle', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  if (room.phase !== 'finished' || !room.seasonId)
    return res.status(400).json({ error: 'Sezono taškų parodyti negalima' });
  room.showSeason = !room.showSeason;
  io.to(roomId).emit('leaderboard', finalLeaderboardPayload(room));
  res.json({ showSeason: room.showSeason });
});

app.delete('/api/host/room/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  if (!rooms[roomId])
    return res.status(404).json({ error: 'Kambarys nerastas' });
  io.to(roomId).emit('room-closed');
  delete rooms[roomId];
  res.json({ ok: true });
});

app.post('/api/team/join', (req, res) => {
  const teams = loadTeams();
  const query = (req.body.query || '').trim();
  if (!query)
    return res.status(400).json({ error: 'Įvesk komandos pavadinimą arba ID' });

  const idKey = Object.keys(teams).find(
    (id) => id.toUpperCase() === query.toUpperCase()
  );
  if (idKey) return res.json({ id: idKey, name: teams[idKey].name });

  const nameEntry = Object.entries(teams).find(
    ([, t]) => t.name.toLowerCase() === query.toLowerCase()
  );
  if (nameEntry) return res.json({ id: nameEntry[0], name: nameEntry[1].name });

  const newId = generateId(teams);
  teams[newId] = { name: query };
  saveTeams(teams);
  res.json({ id: newId, name: query });
});

// Host-only socket.io room for a game room's team status list.
function hostWatchChannel(roomId) {
  return `host-watch:${roomId}`;
}

// Every team that joined the room: whether its phone is connected right now
// and its last internet check (online, and how long ago — the host page
// treats an old check as unknown).
function teamStatusPayload(roomId) {
  const room = rooms[roomId];
  const teams = loadTeams();
  const connected = new Set();
  for (const [, s] of io.sockets.sockets) {
    if (s.connected && s.data.roomId === roomId && s.data.teamId)
      connected.add(s.data.teamId);
  }
  const now = Date.now();
  return Array.from(room.joinedTeams)
    .map((teamId) => {
      const status = room.internetStatus[teamId];
      return {
        teamId,
        name: teams[teamId] ? teams[teamId].name : teamId,
        connected: connected.has(teamId),
        online: status ? status.online : null,
        checkedAgoMs: status ? now - status.at : null
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'lt'));
}

function emitTeamStatus(roomId) {
  io.to(hostWatchChannel(roomId)).emit('team-status', teamStatusPayload(roomId));
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, teamId, teamName }) => {
    const room = rooms[roomId];
    if (!room) return;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.teamId = teamId;
    if (teamId) {
      room.joinedTeams.add(teamId);
      // A phone can still remember a team that's no longer in teams.json
      // (e.g. the file was reset) — re-register it so its scores aren't
      // silently dropped by recordStageScores.
      const teams = loadTeams();
      if (!teams[teamId] && typeof teamName === 'string' && teamName.trim()) {
        teams[teamId] = { name: teamName.trim() };
        saveTeams(teams);
      }
    }

    if (room.phase === 'finished') {
      socket.emit('leaderboard', finalLeaderboardPayload(room));
    } else if (room.phase === 'stage-results') {
      socket.emit('leaderboard', {
        rows: room.leaderboard,
        final: false,
        stageName: currentStage(room).name
      });
    } else if (room.phase === 'stage-answers') {
      socket.emit('stage-answers', room.stageReview);
    } else if (room.phase === 'game-intro') {
      socket.emit('game-intro', { gameName: room.name });
    } else if (room.phase === 'stage-intro') {
      socket.emit('stage-intro', {
        stageName: currentStage(room).name,
        stageNumber: room.stageIndex + 1,
        stageCount: games[room.gameId].stages.length
      });
    } else if (room.phase === 'question' && room.questionIndex >= 0) {
      socket.emit('question', questionPayloadFor(room, teamId));
    }
    if (teamId) {
      socket.emit('internet-warning', { enabled: room.internetWarning });
      emitTeamStatus(roomId);
    }
  });

  // Host pages subscribe to the live list of teams and whether each one's
  // phone can reach the internet. Gated on the same cookie as the host
  // pages themselves — players must never see who's flagged.
  socket.on('host-watch', (roomId) => {
    if (!rooms[roomId] || !isHostAuthed({ headers: socket.handshake.headers }))
      return;
    socket.join(hostWatchChannel(roomId));
    socket.emit('team-status', teamStatusPayload(roomId));
    socket.emit('internet-warning', { enabled: rooms[roomId].internetWarning });
  });

  // Each player's phone periodically tries to reach an outside site; with
  // the hotspot run offline, reaching it means the phone has another way
  // online (mobile data).
  socket.on('internet-status', (payload) => {
    const room = rooms[socket.data.roomId];
    const teamId = socket.data.teamId;
    if (!room || !teamId) return;
    room.internetStatus[teamId] = {
      online: !!(payload && payload.online),
      at: Date.now()
    };
    // Pushed on every check (not just changes) so the host page's "last
    // checked" stays fresh — it treats a check older than 30s as unknown.
    emitTeamStatus(socket.data.roomId);
  });

  socket.on('disconnect', () => {
    if (socket.data.teamId && rooms[socket.data.roomId])
      emitTeamStatus(socket.data.roomId);
  });

  // index defaults to the live question. An earlier (already finalized)
  // question of the same stage can still be changed while the stage is
  // running — its score is reversed, the new pick stored, and re-scored.
  // The value is the picked option's id, or for a typed-answer question the
  // typed string.
  socket.on('select', (value, index) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'question' || room.questionIndex < 0) return;
    if (!socket.data.teamId) return;
    const targetIndex = Number.isInteger(index) ? index : room.questionIndex;
    const entry = room.questionHistory[targetIndex];
    if (!entry) return;
    if (typeof value !== 'string') return;
    let selection;
    if (entry.textAnswer) {
      selection = value.slice(0, 200);
    } else {
      if (!entry.options.some((o) => o.id === value)) return;
      selection = value;
    }

    // A changed typed answer drops the host's earlier call on the old one.
    if (entry.textAnswer && entry.selections[socket.data.teamId] !== selection)
      delete entry.textOverrides[socket.data.teamId];

    if (entry.finalized) {
      unfinalizeEntry(room, targetIndex);
      entry.selections[socket.data.teamId] = selection;
      finalizeEntry(room, targetIndex);
    } else {
      entry.selections[socket.data.teamId] = selection;
    }
  });

  // The host's <audio> element is muted — it's just there so the host can see
  // and control playback (native scrubber, elapsed time, volume). Every play/
  // pause/seek/volume change it makes is relayed here as a state snapshot, and
  // the view screen's own (unmuted) <audio> element mirrors it exactly.
  socket.on('audio-state', (payload) => {
    const roomId = payload && payload.roomId;
    if (!roomId || !rooms[roomId]) return;
    io.to(roomId).emit('audio-state', {
      src: (payload.src || '').toString(),
      paused: !!payload.paused,
      time: Number(payload.time) || 0,
      volume: Math.min(1, Math.max(0, Number(payload.volume) || 0)),
      clipMode: !!payload.clipMode,
      clipStart: Number(payload.clipStart) || 0,
      clipEnd: payload.clipEnd != null ? Number(payload.clipEnd) : null
    });
  });

  // Host-triggered remote control for the view screen's fullscreen image
  // display — the view screen itself has no clickable controls of its own
  // (besides the one-time "enable sound" button), everything is driven here.
  // The host sends the actual image URL(s) along with the command rather than
  // relying on view's own DOM state, since this also has to work for a
  // question the host is reviewing on stage-answers, not just the live one.
  socket.on('fullscreen-command', (payload) => {
    const roomId = payload && payload.roomId;
    const action = payload && payload.action;
    if (!roomId || !rooms[roomId]) return;
    if (!['image', 'options', 'close'].includes(action)) return;

    // Picture URLs only — never any text (a question's or an option's)
    // that could end up as an alt on the view screen and give an answer away.
    const out = { action };
    if (action === 'image') {
      out.src = (payload.src || '').toString();
    } else if (action === 'options') {
      out.images = Array.isArray(payload.images)
        ? payload.images
            .slice(0, 20)
            .map((i) => ({ src: ((i && i.src) || '').toString() }))
        : [];
    }
    io.to(roomId).emit('fullscreen-command', out);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Quiz server running on http://0.0.0.0:${PORT}`);
  console.log('Players join at: ' + joinUrl());
  if (!process.env.LAN_IP) {
    const candidates = lanAddressCandidates();
    if (candidates.length === 0) {
      console.log(
        'No network found — turn on the hotspot; the QR code picks it up automatically.'
      );
    } else {
      console.log(
        'Detected addresses (first one is used): ' +
          candidates.map((c) => `${c.address} (${c.adapter})`).join(', ')
      );
    }
  }
  console.log('Host control page: http://localhost:' + PORT + '/host');
  console.log('View screen: http://localhost:' + PORT + '/view');
  console.log('====================================');
  console.log('HOST ACCESS CODE: ' + HOST_CODE);
  console.log('====================================');
});
