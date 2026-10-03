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
// <%- icon('close') %> in any template: an inline SVG icon (public/icons.js).
app.locals.icon = require('./public/icons').icon;

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

// New games being written: the editor saves one here as it's filled in —
// as-is, nothing checked — so leaving the page (or the server stopping)
// loses nothing. Kept apart from games.json, so a half-made game can never
// be picked for a room. Keyed by the id reserved for the game (its media
// folder too); saving it as a game takes that id and deletes the draft.
const DRAFTS_FILE = path.join(__dirname, 'data', 'drafts.json');
let drafts = loadJsonFile(DRAFTS_FILE);

function saveDrafts() {
  saveJsonFile(DRAFTS_FILE, drafts);
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

// A question's kind: 'choice' (options, one correct), 'text' (one option
// or several — answers players type in, all of them right for the point;
// ordered: in that order), 'yesno' (fixed Taip / Ne, answer
// 'yes' or 'no'), 'chain' (several clues, each with its own typed answer,
// in order), or 'hints' (several hints, shown one at a time, and one typed
// answer — see hintPoints). Games saved before there was a type field are
// told apart by their option count, as they always were. Mirrors
// game-shared.js.
const QUESTION_TYPES = ['choice', 'text', 'yesno', 'chain', 'hints'];
function questionType(q) {
  if (QUESTION_TYPES.includes(q.type)) return q.type;
  return Array.isArray(q.options) && q.options.length === 1 ? 'text' : 'choice';
}

// What a question is called wherever it's listed — a chain (or a hints
// question) needs no text of its own, its clues being the question. A
// picture or song question with no text stays blank: the picture or the
// song is the question.
function questionTitle(q) {
  if (q.question) return q.question;
  if (q.type === 'chain') return 'Grandinėlė';
  if (q.type === 'hints') return 'Užuominos';
  return '';
}

// A yes/no question's two answers, always in this order — never shuffled.
const YES_NO_OPTIONS = [
  { id: 'yes', text: 'Taip' },
  { id: 'no', text: 'Ne' }
];

// Turns an editor form submission ({ name, stages: [{ id?, name, questions:
// [{ id?, type, question, img, audio, audioStart, audioEnd, bonus?: {
// question, answer }, and by type: options: [{ id?, text, img }]
// (choice/text, with ordered?: true on a text one whose answers go in
// order), answer: 'yes'|'no' (yesno), hints: [string] and answer:
// string (hints) or links: [{ clue, img?, answer }]
// (chain) }] }] }) into the games.json shape. The first option in the array
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
// A list of rules as typed: blank lines dropped, anything else ignored.
function normalizeRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((r) => (typeof r === 'string' ? r.trim() : ''))
    .filter(Boolean);
}

// The rules every new game starts with ("Bendros taisyklės" on the games
// page), kept in settings.json. A game gets a copy when it's created —
// changing them later doesn't touch games already made.
function loadDefaultRules() {
  return normalizeRules(loadSettings().defaultRules);
}

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
      if (!q) return { error: 'Kiekvienas klausimas turi turėti tekstą' };
      const type = questionType(q);
      const questionText = (q.question || '').trim();
      // A chain's clues (or the hints) are its question, and a picture or a
      // song can be one too (the stage name says what to answer) — then the
      // text is optional.
      const hasMedia = !!((q.img || '').trim() || (q.audio || '').trim());
      if (!questionText && type !== 'chain' && type !== 'hints' && !hasMedia)
        return {
          error:
            'Kiekvienas klausimas turi turėti tekstą, nuotrauką arba garso įrašą'
        };
      const label =
        questionText ||
        (type === 'chain'
          ? 'Grandinėlė'
          : type === 'hints'
            ? 'Užuominos'
            : `${stageName} nr. ${questions.length + 1}`);
      const chainLabel = questionText ? `Grandinėlė "${questionText}"` : 'Grandinėlė';
      const question = {
        id: pickId(q.id, usedQuestionIds),
        type,
        question: questionText
      };

      let optionImgs = [];
      if (type === 'choice' || type === 'text') {
        const raw = Array.isArray(q.options) ? q.options : [];
        if (type === 'choice' && raw.length < 2)
          return {
            error: `Klausimas "${label}" turi turėti bent 2 atsakymo variantus`
          };
        if (type === 'text' && raw.length < 1)
          return {
            error: `Klausimas "${label}" turi turėti įrašytą teisingą atsakymą`
          };
        const authored = raw.map((o) => ({
          id: o && o.id,
          text: ((o && o.text) || '').trim(),
          img: type === 'choice' ? ((o && o.img) || '').trim() : ''
        }));
        // A picture option has no text at all — the view screen and the
        // answers show it by its letter (A, B, C…), and any text it kept
        // (e.g. "Italija") would give the answer away, even as an alt. A
        // typed-answer question's options are the answers to type, though,
        // so those always have text (and no picture).
        if (type === 'choice') {
          authored.forEach((o) => {
            if (o.img) o.text = '';
          });
        }
        if (type === 'text' && authored.some((o) => !o.text)) {
          return {
            error:
              authored.length > 1
                ? `Klausimas "${label}" turi tuščią atsakymą`
                : `Klausimas "${label}" turi turėti įrašytą teisingą atsakymą`
          };
        }
        if (authored.some((o) => !o.text && !o.img)) {
          return {
            error: `Klausimas "${label}" turi tuščią atsakymo variantą`
          };
        }
        optionImgs = authored.map((o) => o.img);
        authored.forEach((o) => {
          o.id = pickId(o.id, usedOptionIds);
        });
        question.answer = authored[0].id;

        // A choice question's options are stored in shuffled order so the
        // file itself doesn't give away the answer by position (display
        // order is reshuffled per room anyway, in createHistoryEntry). Fresh
        // ids are random, so they don't either. A typed-answer question's
        // answers keep their order — it can be the one they go in.
        question.options = (type === 'choice' ? shuffle(authored) : authored).map(
          (o) => {
            const option = { id: o.id, text: o.text };
            if (o.img) option.img = o.img;
            return option;
          }
        );
        if (type === 'text' && authored.length > 1 && q.ordered)
          question.ordered = true;
      } else if (type === 'yesno') {
        if (q.answer !== 'yes' && q.answer !== 'no')
          return {
            error: `Klausimas "${label}": pažymėk teisingą atsakymą – Taip arba Ne`
          };
        question.answer = q.answer;
      } else if (type === 'hints') {
        const hints = (Array.isArray(q.hints) ? q.hints : []).map((h) =>
          typeof h === 'string' ? h.trim() : ''
        );
        if (hints.length < 2)
          return { error: `Klausimas "${label}" turi turėti bent 2 užuominas` };
        if (hints.some((h) => !h))
          return { error: `Klausimas "${label}" turi tuščią užuominą` };
        const answer = typeof q.answer === 'string' ? q.answer.trim() : '';
        if (!answer)
          return {
            error: `Klausimas "${label}" turi turėti įrašytą teisingą atsakymą`
          };
        question.hints = hints;
        question.answer = answer;
      } else {
        // A clue can be a picture instead of text — shown by its number
        // (1, 2, 3…) on the view screen, so like a picture option it keeps
        // no text.
        const links = (Array.isArray(q.links) ? q.links : []).map((l) => {
          const img = ((l && l.img) || '').trim();
          const link = {
            clue: img ? '' : ((l && l.clue) || '').trim(),
            answer: ((l && l.answer) || '').trim()
          };
          if (img) link.img = img;
          return link;
        });
        if (links.length < 2)
          return { error: `${chainLabel} turi turėti bent 2 užuominas` };
        if (links.some((l) => (!l.clue && !l.img) || !l.answer))
          return {
            error: `${chainLabel}: kiekviena užuomina turi turėti tekstą arba nuotrauką ir atsakymą`
          };
        optionImgs = links.map((l) => l.img);
        question.links = links;
      }

      // "media:..." points at a file kept in the GitHub Pages editor's
      // browser — it only works once imported from that editor's .zip export
      // (the file is uploaded then), never as-is.
      const mediaValues = [q.img, q.audio, ...optionImgs];
      if (mediaValues.some((v) => typeof v === 'string' && v.startsWith('media:')))
        return {
          error: `Klausimas "${label}" nurodo failą, kurio nėra — importuok žaidimą iš .zip failo`
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
            error: `Klausimas "${label}" turi "iki" laiką didesnį už "nuo" laiką`
          };
        }
      }

      // The optional extra answer (e.g. the artist, after the song): typed
      // in, worth a point only when the main answer is right. Its question
      // is optional; with neither filled in, there's none.
      const bonusQuestion = ((q.bonus && q.bonus.question) || '').trim();
      const bonusAnswer = ((q.bonus && q.bonus.answer) || '').trim();
      if (bonusQuestion && !bonusAnswer)
        return { error: `Klausimas "${label}": įrašyk papildomą atsakymą` };
      if (bonusAnswer)
        question.bonus = { question: bonusQuestion, answer: bonusAnswer };
      questions.push(question);
    }

    // Optional, shown under the stage's name on its intro slide.
    const stageTopic = typeof stage.topic === 'string' ? stage.topic.trim() : '';
    const stageDescription =
      typeof stage.description === 'string' ? stage.description.trim() : '';
    stages.push({
      id: stageId,
      name: stageName,
      ...(stageTopic ? { topic: stageTopic } : {}),
      ...(stageDescription ? { description: stageDescription } : {}),
      questions
    });
  }

  // The game's rules, one per line, shown on their own slide right after
  // the game's name — optional; blank lines are dropped.
  const game = { name };
  // One picture behind the whole game on the view screen — optional.
  const background =
    typeof body.background === 'string' ? body.background.trim() : '';
  if (background.startsWith('media:'))
    return {
      error:
        'Fono nuotrauka nurodo failą, kurio nėra — importuok žaidimą iš .zip failo'
    };
  if (background) game.background = background;
  const rules = normalizeRules(body.rules);
  if (rules.length) game.rules = rules;
  game.stages = stages;
  return { game };
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
// phase: 'game-intro' | 'game-rules' | 'stage-intro' | 'question' | 'stage-answers' | 'stage-results' | 'finished'
// game-intro is a one-time title slide with just the game's name, shown only
// once at the very start of a room, before the first stage-intro. game-rules
// comes right after it — only for a game that has rules.
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
    question: questionTitle(currentStage(room).questions[index]),
    type: entry.type,
    options: entry.options,
    textAnswer: entry.textAnswer,
    answerCount: entry.answerCount,
    ordered: entry.ordered,
    clues: entry.clues,
    clueImgs: entry.clueImgs,
    ...hintsProgress(entry),
    linkCount: entry.clues ? entry.clues.length : 0,
    hasBonus: entry.bonusAnswer != null,
    bonusQuestion: entry.bonusQuestion,
    img: entry.img,
    audio: entry.audio,
    audioStart: entry.audioStart,
    audioEnd: entry.audioEnd
  };
}

// How a picked option reads in the host's review: its text, or for a
// picture option the letter it had on the view screen.
function optionLabel(entry, optionId) {
  const i = entry.options.findIndex((o) => o.id === optionId);
  if (i < 0) return '';
  return entry.options[i].img
    ? String.fromCharCode(65 + i)
    : entry.options[i].text;
}

// Host-only: for each question in the stage with something typed in — a
// typed answer, a chain, or an extra answer (keyed by its index) — what
// every team answered and whether it currently counts, so the host can
// accept a misspelling or reject a lucky match. Every team that joined the
// room is listed, even with nothing typed: a team answering on paper still
// gets marked right by hand here (typing on a phone is the hard part;
// tapping an option isn't, so a choice question's own answer isn't
// markable — only its extra answer, if it has one). Teams the host added
// to play on paper aren't: their points come in per stage, as a total.
function answersForReview(room) {
  const teams = loadTeams();
  const out = {};
  room.questionHistory.forEach((entry, index) => {
    if (!entry) return;
    const mainEditable = isTypedType(entry.type);
    const hasBonus = entry.bonusAnswer != null;
    if (!mainEditable && !hasBonus) return;
    const teamIds = new Set([
      ...room.joinedTeams,
      ...Object.keys(entry.selections),
      ...Object.keys(entry.bonusSelections)
    ]);
    room.offlineTeams.forEach((teamId) => teamIds.delete(teamId));
    const rows = Array.from(teamIds)
      .map((teamId) => {
        const selected = entry.selections[teamId];
        const bonusTyped = entry.bonusSelections[teamId];
        const row = {
          teamId,
          teamName: teams[teamId] ? teams[teamId].name : teamId,
          mainCorrect: isMainCorrect(entry, teamId),
          bonusTyped: typeof bonusTyped === 'string' ? bonusTyped.trim() : '',
          bonusCorrect: isBonusCorrect(entry, teamId)
        };
        if (entry.type === 'text' && entry.answerCount > 1) {
          row.links = mySelectionFor(entry, teamId).map((s) => s.trim());
          row.ordered = entry.ordered;
        } else if (entry.type === 'chain') {
          row.links = entry.clues.map((_, i) =>
            Array.isArray(selected) && typeof selected[i] === 'string'
              ? selected[i].trim()
              : ''
          );
        } else if (entry.type === 'text' || entry.type === 'hints') {
          row.typed = typeof selected === 'string' ? selected.trim() : '';
          if (entry.type === 'hints' && teamId in entry.locks)
            row.lockedPoints = entry.locks[teamId];
        } else {
          row.typed = optionLabel(entry, selected);
        }
        return row;
      })
      .sort((a, b) => a.teamName.localeCompare(b.teamName, 'lt'));
    out[index] = {
      type: entry.type,
      answerCount: entry.answerCount || 0,
      ordered: !!entry.ordered,
      mainEditable,
      hasBonus,
      bonusQuestion: entry.bonusQuestion,
      rows
    };
  });
  return out;
}

// What the stage-answers screen shows as a question's correct answer: the
// option (a picture one by the letter it had on the view screen in this
// room — its shuffled order, kept in the history entry — the same A, B, C…
// players picked by, not the picture's file or text), Taip/Ne, or for a
// chain each clue's answer in order (the clues come along in `chain`).
function correctAnswerFor(q, entry) {
  const type = questionType(q);
  if (type === 'chain')
    return {
      correctAnswer: q.links.map((l) => l.answer).join(' → '),
      correctAnswerImg: null
    };
  if (type === 'yesno')
    return {
      correctAnswer: q.answer === 'yes' ? 'Taip' : 'Ne',
      correctAnswerImg: null
    };
  if (type === 'hints')
    return { correctAnswer: q.answer, correctAnswerImg: null };
  if (type === 'text')
    return {
      correctAnswer: q.options.map((o) => o.text).join(q.ordered ? ' → ' : ', '),
      correctAnswerImg: null
    };
  const correctOption = q.options.find((o) => o.id === q.answer);
  const shownIndex = entry
    ? entry.options.findIndex((o) => o.id === q.answer)
    : -1;
  return {
    correctAnswer:
      correctOption.img && shownIndex >= 0
        ? String.fromCharCode(65 + shownIndex)
        : correctOption.text || '—',
    correctAnswerImg: resolveMediaSrc(correctOption.img)
  };
}

// A chain's clues for the host's fullscreen grid when any of them is a
// picture — every clue a cell (a picture, or its text), each with the number
// it has on the view screen (1, 2, 3…) — or null when none is a picture.
function chainClueImages(links) {
  if (!links || !links.some((l) => l.img)) return null;
  return links.map((l, i) =>
    l.img
      ? { src: resolveMediaSrc(l.img), label: String(i + 1) }
      : { text: l.clue, label: String(i + 1) }
  );
}

function buildStageReview(room) {
  const stage = currentStage(room);
  return {
    stageName: stage.name,
    questions: stage.questions.map((q, i) => {
      const { correctAnswer, correctAnswerImg } = correctAnswerFor(
        q,
        room.questionHistory[i]
      );
      return {
        number: i + 1,
        question: questionTitle(q),
        correctAnswer,
        chain: q.links
          ? q.links.map((l) => ({
              clue: l.clue,
              img: resolveMediaSrc(l.img),
              answer: l.answer
            }))
          : null,
        clueImages: chainClueImages(q.links),
        hints: q.hints || null,
        bonus: q.bonus
          ? { question: q.bonus.question, answer: q.bonus.answer }
          : null,
        img: resolveMediaSrc(q.img),
        correctAnswerImg,
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
// stageDisplayName), and also kept with the team (rememberHistoryNames), so
// it still reads once the game or stage is deleted. Purely backend
// bookkeeping — never shown to clients.
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
    rememberHistoryNames(teams[teamId]);
  });
  saveTeams(teams);
}

// The names of the games and stages a team's history points at, kept with
// the team — gameNames { gameId: name }, stageNames { gameId: { stageId:
// name } } — since the history itself holds only ids: once a game (or one
// of its stages) is deleted, these are all that's left to show. Taken from
// games.json while the game is there, so they follow renames. Returns
// whether anything changed.
function rememberHistoryNames(team) {
  let changed = false;
  Object.values(team.seasons || {}).forEach((gamesForSeason) => {
    Object.entries(gamesForSeason).forEach(([gameId, stageScores]) => {
      const game = games[gameId];
      if (!game) return;
      team.gameNames = team.gameNames || {};
      if (team.gameNames[gameId] !== game.name) {
        team.gameNames[gameId] = game.name;
        changed = true;
      }
      Object.keys(stageScores).forEach((stageKey) => {
        const stage = game.stages.find((st) => st.id === stageKey);
        if (!stage) return;
        team.stageNames = team.stageNames || {};
        const names = (team.stageNames[gameId] = team.stageNames[gameId] || {});
        if (names[stageKey] !== stage.name) {
          names[stageKey] = stage.name;
          changed = true;
        }
      });
    });
  });
  return changed;
}

// The same for every team — at startup (history recorded before names were
// kept), and before a game is deleted or saved (a stage may be removed).
function rememberAllHistoryNames() {
  const teams = loadTeams();
  let changed = false;
  Object.values(teams).forEach((t) => {
    if (rememberHistoryNames(t)) changed = true;
  });
  if (changed) saveTeams(teams);
}

// History stores only stage ids; the name comes from games.json, or — the
// stage (or its whole game) since deleted — the one kept with the team (see
// rememberHistoryNames). Falls back to the key itself when neither has it
// (an old entry that was keyed by name).
function stageDisplayName(gameId, stageKey, team) {
  const game = games[gameId];
  const stage = game && game.stages.find((s) => s.id === stageKey);
  if (stage) return stage.name;
  const kept = team && team.stageNames && team.stageNames[gameId];
  return (kept && kept[stageKey]) || stageKey;
}

// A game's name for the history: from games.json, or the one kept with the
// team once it's deleted, or just its id.
function gameDisplayName(gameId, team) {
  if (games[gameId]) return games[gameId].name;
  return (team && team.gameNames && team.gameNames[gameId]) || gameId;
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

// A team's penalty points for a season — kept apart from its scores (in
// teams.json under penalties -> season id) and never taken off them.
function seasonPenalty(team, seasonId) {
  return (team && team.penalties && team.penalties[seasonId]) || 0;
}

// Every team with penalty points this season, most first. Teams in this room
// always show up, even with none (0) — same as buildSeasonLeaderboard.
function buildPenaltyLeaderboard(room) {
  const seasonId = room.seasonId;
  const teams = loadTeams();
  return Object.entries(teams)
    .filter(
      ([teamId, t]) =>
        seasonPenalty(t, seasonId) > 0 || room.joinedTeams.has(teamId)
    )
    .map(([teamId, t]) => ({
      teamId,
      name: t.name,
      score: seasonPenalty(t, seasonId)
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'lt'));
}

// What the finished screen shows: this game's totals, or — once the host
// toggles to them — the whole active season's standings or penalty points.
function finalLeaderboardPayload(room) {
  if (room.leaderboardView === 'season')
    return {
      rows: buildSeasonLeaderboard(room),
      final: true,
      seasonId: room.seasonId
    };
  if (room.leaderboardView === 'penalties')
    return {
      rows: buildPenaltyLeaderboard(room),
      final: true,
      seasonId: room.seasonId,
      penalties: true
    };
  return { rows: room.leaderboard, final: true };
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

// A room's copy of a question. Anything typed in is checked against answers
// kept only here, server-side — a typed-answer question gets no options, a
// chain sends only its clues (to the view screen) — so nothing about an
// answer ever reaches a player or view screen. A yes/no question's Taip / Ne
// keep their order; only a choice question's options are shuffled.
function createHistoryEntry(q) {
  const type = questionType(q);
  let options = [];
  if (type === 'choice')
    options = shuffle(q.options).map((o) =>
      // text dropped here too, for games saved before picture options
      // lost theirs (see normalizeGamePayload) — this is what the view
      // screen gets
      o.img ? { id: o.id, text: '', img: resolveMediaSrc(o.img) } : o
    );
  else if (type === 'yesno') options = YES_NO_OPTIONS.map((o) => ({ ...o }));
  return {
    type,
    options,
    textAnswer: type === 'text',
    // Typed-answer: every answer to type (one, or several to list), and
    // whether they have to be in that order. Hints: its one answer.
    correctTexts: type === 'text' ? q.options.map((o) => o.text) : null,
    answerCount: type === 'text' ? q.options.length : 0,
    ordered: type === 'text' && !!q.ordered,
    correctText: type === 'hints' ? q.answer : null,
    answer: q.answer,
    clues: type === 'chain' ? q.links.map((l) => l.clue) : null,
    clueImgs: type === 'chain' ? q.links.map((l) => resolveMediaSrc(l.img)) : null,
    correctLinks: type === 'chain' ? q.links.map((l) => l.answer) : null,
    // Hints question: all its hints (only the shown ones ever leave the
    // server), how many are shown so far — the first one right away, the
    // rest one by one as the host reveals them; kept here, so stepping back
    // to the question later shows them all again — and per team, the points
    // its answer was locked in for (see hintPoints).
    hints: type === 'hints' ? q.hints.slice() : null,
    revealedHints: type === 'hints' ? 1 : 0,
    locks: {},
    bonusQuestion: q.bonus ? q.bonus.question || '' : null,
    bonusAnswer: q.bonus ? q.bonus.answer : null,
    img: resolveMediaSrc(q.img),
    audio: q.audio || null,
    audioStart: q.audioStart || null,
    audioEnd: q.audioEnd || null,
    // Per team: the option id, the typed string, or (chain) an array of
    // typed strings, one per clue.
    selections: {},
    bonusSelections: {},
    // Typed-answer and chain only: the host's manual correct/incorrect call
    // per team (from the stage-answers review), overriding the automatic
    // match. bonusOverrides is the same for the extra answer.
    textOverrides: {},
    bonusOverrides: {},
    finalized: false,
    awardedPoints: {}
  };
}

// The lenient automatic match (see normalizeTypedAnswer). Blank (or
// punctuation-only) never matches.
function typedMatches(typed, correct) {
  if (typeof typed !== 'string') return false;
  const normalized = normalizeTypedAnswer(typed);
  return normalized !== '' && normalized === normalizeTypedAnswer(correct);
}

// Question types answered by typing — the host can mark those by hand.
function isTypedType(type) {
  return type === 'text' || type === 'chain' || type === 'hints';
}

// A hints question is worth as many points as it has hints, if a team locks
// its answer in while only the first is shown — one less for every hint
// shown after that, down to 1 with all of them shown. An answer never
// locked in is worth 1 point too.
function hintPoints(entry) {
  return entry.hints.length - entry.revealedHints + 1;
}

// A hints question's progress for the view screen: the hints shown so far —
// never one not shown yet, nor how many are left. What an answer is worth
// is only told to a team once it's locked in, so it goes nowhere else.
function hintsProgress(entry) {
  if (entry.type !== 'hints') return {};
  return { hints: entry.hints.slice(0, entry.revealedHints) };
}

// A typed-answer question's answers: with one, the typed string; with
// several, one typed string per answer — every answer has to be there, in
// the same order if it's an ordered one, otherwise in any order (each typed
// string standing for a different answer).
function textAnswersMatch(entry, selected) {
  if (entry.answerCount === 1)
    return typedMatches(
      Array.isArray(selected) ? selected[0] : selected,
      entry.correctTexts[0]
    );
  if (!Array.isArray(selected)) return false;
  if (entry.ordered)
    return entry.correctTexts.every((answer, i) => typedMatches(selected[i], answer));
  const unused = selected.slice();
  return entry.correctTexts.every((answer) => {
    const i = unused.findIndex((typed) => typedMatches(typed, answer));
    if (i < 0) return false;
    unused.splice(i, 1);
    return true;
  });
}

// Whether a team's main answer counts: the right option, or — typed in —
// the host's call if they made one, otherwise the automatic match (for a
// chain, every clue's answer has to match).
function isMainCorrect(entry, teamId) {
  const selected = entry.selections[teamId];
  if (isTypedType(entry.type)) {
    if (teamId in entry.textOverrides) return entry.textOverrides[teamId];
    if (entry.type === 'text') return textAnswersMatch(entry, selected);
    if (entry.type === 'hints') return typedMatches(selected, entry.correctText);
    return (
      Array.isArray(selected) &&
      entry.correctLinks.every((answer, i) => typedMatches(selected[i], answer))
    );
  }
  return selected !== undefined && selected === entry.answer;
}

// Whether a team's extra answer is right (the host's call, else the
// automatic match) — it only earns a point on top of a right main answer.
function isBonusCorrect(entry, teamId) {
  if (entry.bonusAnswer == null) return false;
  if (teamId in entry.bonusOverrides) return entry.bonusOverrides[teamId];
  return typedMatches(entry.bonusSelections[teamId], entry.bonusAnswer);
}

// Scores whoever answered the question, using the last pick each team sent:
// 1 point for a right main answer (see isMainCorrect) — on a hints question,
// the points it was locked in for (see hintPoints) — plus 1 for a right
// extra answer on top of it, 0 otherwise. Records what was awarded per team
// so unfinalizeEntry can reverse it exactly if the host steps back to this
// question.
function finalizeEntry(room, index) {
  const entry = room.questionHistory[index];
  if (!entry || entry.finalized) return;
  const awarded = {};

  // Teams the host marked by hand count too, typed or not (paper answers).
  const teamIds = new Set([
    ...Object.keys(entry.selections),
    ...Object.keys(entry.textOverrides),
    ...Object.keys(entry.bonusSelections),
    ...Object.keys(entry.bonusOverrides)
  ]);
  teamIds.forEach((teamId) => {
    if (!isMainCorrect(entry, teamId)) return;
    const main =
      entry.type === 'hints' && teamId in entry.locks ? entry.locks[teamId] : 1;
    const points = main + (isBonusCorrect(entry, teamId) ? 1 : 0);
    awarded[teamId] = points;
    room.scores[teamId] = (room.scores[teamId] || 0) + points;
  });

  entry.awardedPoints = awarded;
  entry.finalized = true;
}

// Changes an entry's picks or the host's calls on them: an already-scored
// question is unscored first and re-scored after, so points never double up.
function updateEntry(room, index, change) {
  const entry = room.questionHistory[index];
  if (!entry.finalized) return change();
  unfinalizeEntry(room, index);
  change();
  finalizeEntry(room, index);
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
// the answer away just the same, so that's left out too. With a picture
// among the options, the view screen shows a text option by its letter
// too, so a phone gets it as "C. Italija".
function optionsForPlayer(options) {
  const lettered = options.some((o) => o.img);
  return options.map((o, i) => {
    const letter = String.fromCharCode(65 + i);
    if (o.img) return { id: o.id, label: letter };
    return { id: o.id, text: lettered ? `${letter}. ${o.text}` : o.text };
  });
}

// What a phone needs to answer a question: how to answer it (options, a
// text field, one per chain clue, an extra answer field) and this team's
// answers so far — but never the question itself, a chain's clues or the
// extra answer's question, which are only on the view screen.
function answerFieldsFor(entry, teamId) {
  return {
    type: entry.type,
    options: optionsForPlayer(entry.options),
    textAnswer: entry.textAnswer,
    answerCount: entry.answerCount,
    ordered: entry.ordered,
    linkCount: entry.clues ? entry.clues.length : 0,
    myLock: entry.locks && teamId in entry.locks ? entry.locks[teamId] : null,
    hasBonus: entry.bonusAnswer != null,
    mySelection: mySelectionFor(entry, teamId),
    myBonus: mySelectionFor(entry, teamId, entry.bonusSelections)
  };
}

function otherShownQuestions(room, teamId, mainIndex) {
  const out = [];
  room.questionHistory.forEach((entry, index) => {
    if (!entry || index === mainIndex) return;
    out.push({
      index,
      number: index + 1,
      ...answerFieldsFor(entry, teamId)
    });
  });
  return out;
}

// A team's current pick: the option id for a choice question, the typed
// string for a typed-answer one ('' if nothing yet), or for a chain an array
// with a typed string per clue.
function mySelectionFor(entry, teamId, selections = entry.selections) {
  const value = teamId && selections[teamId];
  const fieldCount =
    entry.type === 'chain'
      ? entry.clues.length
      : entry.type === 'text' && entry.answerCount > 1
        ? entry.answerCount
        : 0;
  if (fieldCount && selections === entry.selections)
    return Array.from({ length: fieldCount }, (_, i) =>
      Array.isArray(value) && typeof value[i] === 'string' ? value[i] : ''
    );
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
  // The question itself — its text, picture, music, a chain's clues — is
  // only on the view screen; phones just get "Klausimas N", so there's
  // nothing to paste into an AI or feed to Google Lens / Shazam.
  return {
    ...answerFieldsFor(entry, teamId),
    index: mainIndex,
    number: mainIndex + 1,
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

// A hints question's newly revealed hint, to the view screen only — the
// hints are never on the phones, and nothing changes there.
function broadcastHints(room, roomId, index) {
  const entry = room.questionHistory[index];
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.roomId !== roomId || socket.data.teamId) continue;
    socket.emit('hints', { index, ...hintsProgress(entry) });
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
  Object.values(games).forEach((game) => add(game.background));
  Object.values(games).forEach((game) =>
    game.stages.forEach((stage) =>
      stage.questions.forEach((q) => {
        add(q.img);
        add(q.audio);
        (q.options || []).forEach((o) => add(o.img));
        (q.links || []).forEach((l) => add(l.img));
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
// What a file really is, read from its first bytes (every picture/audio
// format starts with a fixed signature) — not from its name or the type the
// browser reports, which can be missing or wrong (e.g. a JPEG saved as
// .jfif). Returns the extension it's stored under, or null if it's neither.
function detectMediaExtension(buf) {
  if (buf.length < 4) return null;
  const ascii = (start, end) => buf.toString('latin1', start, end);

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return '.png';
  if (ascii(0, 4) === 'GIF8') return '.gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return '.wav';
  if (ascii(0, 4) === 'OggS') return '.ogg';
  if (ascii(0, 4) === 'fLaC') return '.flac';
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return '.webm';
  if (ascii(4, 8) === 'ftyp') return '.m4a';
  if (ascii(0, 3) === 'ID3') return '.mp3';
  // No header, straight into audio frames: 11 sync bits, then the layer
  // bits tell AAC (00) from MP3 (anything else).
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return (buf[1] & 0x06) === 0 ? '.aac' : '.mp3';
  }
  // SVG is text: an <svg> tag near the top (after any <?xml ...?>/comments).
  if (/<svg[\s>]/i.test(ascii(0, 1024))) return '.svg';
  return null;
}

app.use(
  '/media',
  express.static(MEDIA_DIR, { maxAge: '365d', immutable: true, index: false })
);

app.post(
  '/api/host/upload',
  express.raw({ type: () => true, limit: MEDIA_MAX_BYTES }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'Failas tuščias' });
    const ext = detectMediaExtension(req.body);
    if (!ext)
      return res
        .status(400)
        .json({ error: 'Galima įkelti tik nuotraukas ir garso failus' });

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
  // Newest first: games.json keeps games in the order they were created
  // (saving an edit doesn't move one), so that order reversed.
  const gameList = Object.keys(games)
    .map((id) => ({
      id,
      name: games[id].name
    }))
    .reverse();
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

  if (room.phase === 'game-rules') {
    return res.render('host/game-rules', {
      title: 'Quiz - Host',
      roomId,
      roomName: room.name,
      rules: game.rules || []
    });
  }

  if (room.phase === 'game-intro') {
    return res.render('host/game-intro', {
      title: 'Quiz - Host',
      roomId,
      roomName: room.name,
      hasRules: !!(game.rules && game.rules.length)
    });
  }

  if (room.phase === 'stage-intro') {
    return res.render('host/stage-intro', {
      title: 'Quiz - Host',
      roomId,
      roomName: room.name,
      stageName: stage.name,
      stageTopic: stage.topic || '',
      stageDescription: stage.description || '',
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
      typedAnswers: answersForReview(room)
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

  // "Next" always goes on from the furthest question shown, even while
  // the host is back on an earlier one (see the /next endpoint).
  const hasMore = room.questionHistory.length < stage.questions.length;
  const hasPrevious = room.questionIndex > 0;
  // Back on an earlier question: one step forward again, through the ones
  // already shown ("next" would skip to a new one).
  const hasForward =
    room.questionIndex >= 0 && room.questionIndex < room.questionHistory.length - 1;
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
    currentQuestionText: currentQuestion ? questionTitle(currentQuestion) : null,
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
    currentQuestionType: currentQuestion ? questionType(currentQuestion) : null,
    // A typed-answer question with several answers: how many, and whether
    // they have to be in order.
    currentQuestionAnswerCount: currentEntry ? currentEntry.answerCount || 0 : 0,
    currentQuestionOrdered: currentEntry ? !!currentEntry.ordered : false,
    currentQuestionLinks:
      currentQuestion && currentQuestion.links
        ? currentQuestion.links.map((l) => ({
            clue: l.clue,
            img: resolveMediaSrc(l.img)
          }))
        : null,
    currentQuestionBonus: currentQuestion ? currentQuestion.bonus || null : null,
    // A hints question: all its hints (the host sees which are still to
    // come) and how many are shown — "next" reveals the next one first.
    currentQuestionHints:
      currentEntry && currentEntry.type === 'hints' ? currentEntry.hints : null,
    revealedHints: currentEntry ? currentEntry.revealedHints || 0 : 0,
    // Taken from the room's history entry, not the stored question — that
    // entry holds this room's shuffled order, the one players and the view
    // screen actually see, so the fullscreen grid matches it. With a
    // picture among them, a text option is a cell of the grid too. A
    // chain's clues go in the same grid, by their numbers.
    currentQuestionOptionImages:
      currentEntry && currentEntry.options.some((o) => o.img)
        ? currentEntry.options.map((o) =>
            o.img ? { src: o.img } : { text: o.text }
          )
        : currentQuestion
          ? chainClueImages(currentQuestion.links)
          : null,
    // How many of the stage's questions have been shown — each gets a
    // number button to jump back (or forward again) to it.
    shownQuestionCount: room.questionHistory.length,
    hasMore,
    hasPrevious,
    hasForward
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
    leaderboardView: room.leaderboardView || 'game'
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

// The games page's two lists: drafts (newest first) above the saved games
// (newest first too — see renderHostDashboard). A draft is whatever the
// editor had, so any part of it may be missing.
function renderGamesList(res, error) {
  const gameList = Object.entries(games)
    .map(([id, g]) => ({
      id,
      name: g.name,
      stageCount: g.stages.length,
      questionCount: g.stages.reduce((n, s) => n + s.questions.length, 0)
    }))
    .reverse();
  const draftList = Object.entries(drafts)
    .map(([id, d]) => {
      const stages = Array.isArray(d.game && d.game.stages) ? d.game.stages : [];
      return {
        id,
        name: (d.game && d.game.name) || '',
        stageCount: stages.length,
        questionCount: stages.reduce(
          (n, s) => n + ((s && Array.isArray(s.questions) && s.questions.length) || 0),
          0
        ),
        updatedAt: d.updatedAt || 0
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.status(error ? 404 : 200).render('host/games', {
    title: 'Quiz - Žaidimai',
    gameList,
    draftList,
    defaultRules: loadDefaultRules(),
    error
  });
}

app.get('/host/games', (req, res) => {
  renderGamesList(res, null);
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
              stageName: stageDisplayName(gameId, stageKey, t),
              score
            })
          );
          return {
            gameId,
            gameName: gameDisplayName(gameId, t),
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
        penalty: seasonPenalty(t, seasonId),
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
    // (Not a draft's either — the draft is saved under it.)
    newGameId: generateId({ ...games, ...drafts }),
    // A new game starts with the shared rules, if there are any.
    game: loadDefaultRules().length ? { rules: loadDefaultRules() } : null,
    isDraft: false,
    defaultRules: [],
    nativeFilePicker: canUseNativeFilePicker(req)
  });
});

// A draft goes back into the same new-game editor, under the id it was
// saved with (so its uploads stay in the same media folder).
app.get('/host/drafts/:draftId/edit', (req, res) => {
  const draft = drafts[req.params.draftId];
  if (!draft) return renderGamesList(res, 'Juodraštis nerastas');
  res.render('host/game-editor', {
    title: 'Quiz - Juodraštis',
    gameId: null,
    newGameId: req.params.draftId,
    game: draft.game,
    isDraft: true,
    // For "Naudoti bendras taisykles" — a draft or a saved game only gets
    // them on request.
    defaultRules: loadDefaultRules(),
    nativeFilePicker: canUseNativeFilePicker(req)
  });
});

app.get('/host/games/:gameId/edit', (req, res) => {
  const game = games[req.params.gameId];
  if (!game) return renderGamesList(res, 'Žaidimas nerastas');
  res.render('host/game-editor', {
    title: 'Quiz - Redaguoti žaidimą',
    gameId: req.params.gameId,
    newGameId: null,
    game,
    isDraft: false,
    defaultRules: loadDefaultRules(),
    nativeFilePicker: canUseNativeFilePicker(req)
  });
});

// The game shown as the view screen would, stepped through without a room
// (public/preview.js) — the same page the GitHub Pages site has.
app.get('/host/games/:gameId/preview', (req, res) => {
  const game = games[req.params.gameId];
  if (!game) return renderGamesList(res, 'Žaidimas nerastas');
  res.render('host/game-preview', { docs: false, game });
});

app.get('/host/:roomId(\\d{6})', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return renderHostDashboard(req, res, 'Kambarys nerastas');
  // For the − / + in every page's bottom bar (_text-scale.ejs).
  res.locals.textScale = textScalePercent(room);
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

// The players' join page and the view dashboard poll this to keep their
// "Aktyvūs kambariai" list current as the host opens and closes rooms.
app.get('/api/rooms', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ rooms: activeRoomList() });
});

// The view dashboard polls this and reloads the QR when it changes, e.g.
// when the hotspot is switched on after the page was opened.
app.get('/api/join-url', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ url: joinUrl() });
});

app.get('/view/:roomId(\\d{6})', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return renderViewDashboard(req, res, 'Kambarys nerastas');
  const game = games[room.gameId];
  res.render('view/screen', {
    title: 'Quiz - View',
    roomId,
    roomName: room.name,
    background: (game && resolveMediaSrc(game.background)) || null
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
      : generateId({ ...games, ...drafts });
  games[gameId] = result.game;
  saveGames();
  // Saved as a game now, so its draft (under the same reserved id) goes.
  if (typeof requested === 'string' && drafts[requested]) {
    delete drafts[requested];
    saveDrafts();
  }
  res.json({ gameId });
});

// The editor's autosave: whatever it has, stored as-is — no checks, a
// draft is allowed to be unfinished. Only the id's shape and the payload
// being an object are checked; the game itself is checked when it's saved
// as a game (POST /api/games).
app.put('/api/host/drafts/:draftId', (req, res) => {
  const draftId = req.params.draftId;
  if (!GAME_ID_PATTERN.test(draftId) || games[draftId])
    return res.status(400).json({ error: 'Netinkamas juodraščio id' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
    return res.status(400).json({ error: 'Netinkamas juodraštis' });
  drafts[draftId] = { game: req.body, updatedAt: Date.now() };
  saveDrafts();
  res.json({ ok: true });
});

// "Bendros taisyklės" on the games page, saved as they're typed.
app.put('/api/host/default-rules', (req, res) => {
  const rules = normalizeRules(req.body && req.body.rules);
  const settings = loadSettings();
  if (rules.length) settings.defaultRules = rules;
  else delete settings.defaultRules;
  saveSettings(settings);
  res.json({ ok: true });
});

app.delete('/api/host/drafts/:draftId', (req, res) => {
  const draftId = req.params.draftId;
  if (!drafts[draftId])
    return res.status(404).json({ error: 'Juodraštis nerastas' });
  delete drafts[draftId];
  saveDrafts();
  res.json({ ok: true });
});

app.put('/api/games/:gameId', (req, res) => {
  const gameId = req.params.gameId;
  if (!games[gameId])
    return res.status(404).json({ error: 'Žaidimas nerastas' });
  const result = normalizeGamePayload(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  // A stage dropped in the editor keeps its name in the teams' history.
  rememberAllHistoryNames();
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
  // Its name (and its stages') stays in the teams' history.
  rememberAllHistoryNames();
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
    // Teams playing on paper, added by the host (see /offline-team), and
    // the points each of them scored per stage, entered by the host —
    // keyed by stage index, then team id.
    offlineTeams: new Set(),
    paperScores: {},
    internetStatus: {},
    internetWarning: false,
    leaderboard: null,
    stageReview: null
  };
  res.json({ roomId });
});

// The active season, for the side panel on every host page (side-panel.js).
app.get('/api/host/season', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ activeSeason: loadSettings().activeSeason || null });
});

function setActiveSeason(season) {
  const settings = loadSettings();
  settings.activeSeason = season;
  saveSettings(settings);
  // Only rooms created from now on get it: every room keeps the season that
  // was active when it was created (see /api/host/room), whatever its phase.
  return settings.activeSeason;
}

app.post('/api/host/season', (req, res) => {
  const season = (req.body.season || '').toString().trim() || null;
  res.json({ activeSeason: setActiveSeason(season) });
});

// The side panel's season button: back to the newest season the teams'
// history has (scores or penalty points recorded under it) — e.g. after
// trying out another number. Nothing recorded yet: left as it is.
app.post('/api/host/season/latest', (req, res) => {
  const seasonIds = new Set();
  Object.values(loadTeams()).forEach((t) => {
    Object.keys(t.seasons || {}).forEach((id) => seasonIds.add(id));
    Object.keys(t.penalties || {}).forEach((id) => seasonIds.add(id));
  });
  const newest = Array.from(seasonIds)
    .filter((id) => id && id !== 'null')
    .sort((a, b) => (Number(b) - Number(a)) || b.localeCompare(a))[0];
  const activeSeason = newest ? setActiveSeason(newest) : loadSettings().activeSeason || null;
  res.json({ activeSeason });
});

// Stage-answers review: the host marks a team's typed answer (part 'main' —
// a typed-answer question or a whole chain) or extra answer (part 'bonus')
// right or wrong by hand (e.g. a typo), re-scoring that question. Only
// until the host moves on — the stage's points are recorded right after.
app.post('/api/host/room/:roomId/typed-answer', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  if (room.phase !== 'stage-answers')
    return res
      .status(400)
      .json({ error: 'Vertinti galima tik rodant etapo atsakymus' });
  const { index, teamId, correct } = req.body || {};
  const part = (req.body && req.body.part) || 'main';
  const entry = Number.isInteger(index) && room.questionHistory[index];
  const markable =
    entry &&
    (part === 'bonus'
      ? entry.bonusAnswer != null
      : part === 'main' && isTypedType(entry.type));
  // Any team in the room — one that typed nothing (answered on paper) can
  // still be marked right.
  if (
    !markable ||
    typeof teamId !== 'string' ||
    !(
      room.joinedTeams.has(teamId) ||
      teamId in entry.selections ||
      teamId in entry.bonusSelections
    )
  )
    return res.status(400).json({ error: 'Atsakymas nerastas' });

  updateEntry(room, index, () => {
    const overrides =
      part === 'bonus' ? entry.bonusOverrides : entry.textOverrides;
    overrides[teamId] = !!correct;
  });
  res.json({
    correct:
      part === 'bonus'
        ? isBonusCorrect(entry, teamId)
        : isMainCorrect(entry, teamId)
  });
});

// Host jumps straight to a question of the current stage already shown
// (its number button on the room page) — the same as stepping back/forward
// to it, picks and revealed hints and all.
// The view screen's text size, as a percentage: 100 to start, changed in
// steps of 25 by the host bar's − / +, from 25 up to 500. Only the text
// scales (see v.text() in styles/_variables.scss), so the host can make it
// readable from the back of the room without zooming the whole page — and
// without their own screen changing too, as browser zoom on the same site
// would.
const TEXT_SCALE_MIN = 25;
const TEXT_SCALE_MAX = 500;
const TEXT_SCALE_STEP = 25;

function textScalePercent(room) {
  return room.textScale || 100;
}

app.post('/api/host/room/:roomId/text-scale', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  const delta = Number(req.body && req.body.delta);
  if (Math.abs(delta) !== TEXT_SCALE_STEP)
    return res.status(400).json({ error: 'Netinkamas žingsnis' });
  room.textScale = Math.min(
    TEXT_SCALE_MAX,
    Math.max(TEXT_SCALE_MIN, textScalePercent(room) + delta)
  );
  io.to(roomId).emit('text-scale', { scale: room.textScale });
  res.json({ scale: room.textScale, min: TEXT_SCALE_MIN, max: TEXT_SCALE_MAX });
});

app.post('/api/host/room/:roomId/goto', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  if (room.phase !== 'question')
    return res
      .status(400)
      .json({ error: 'Pereiti galima tik klausimų rodymo metu' });
  const { index } = req.body;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= room.questionHistory.length ||
    !room.questionHistory[index]
  )
    return res.status(400).json({ error: 'Šis klausimas dar nerodytas' });
  if (index !== room.questionIndex) navigateTo(room, roomId, index);
  res.json({ phase: 'question' });
});

app.post('/api/host/room/:roomId/prev', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  // Before the game's first questions, the opening slides can be walked
  // back through too — the first stage's title to the rules (if any) to the
  // game's name — and forward again with "next". Never back into an earlier
  // stage, though: a later stage's title has no way back.
  const game = games[room.gameId];
  const hasRules = !!(game.rules && game.rules.length);
  if (room.phase === 'game-rules') {
    room.phase = 'game-intro';
    io.to(roomId).emit('game-intro', { gameName: room.name });
    return res.json({ phase: 'game-intro' });
  }
  if (room.phase === 'stage-intro' && room.stageIndex === 0) {
    room.phase = hasRules ? 'game-rules' : 'game-intro';
    if (hasRules) io.to(roomId).emit('game-rules', { rules: game.rules });
    else io.to(roomId).emit('game-intro', { gameName: room.name });
    return res.json({ phase: room.phase });
  }
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
  // A new stage (or its results) changes which paper points can be entered.
  res.on('finish', () => {
    if (rooms[roomId]) emitTeamStatus(roomId);
  });

  // The rules get their own slide after the game's name, if it has any.
  if (room.phase === 'game-intro' && game.rules && game.rules.length) {
    room.phase = 'game-rules';
    io.to(roomId).emit('game-rules', { rules: game.rules });
    return res.json({ phase: 'game-rules' });
  }

  if (room.phase === 'game-intro' || room.phase === 'game-rules') {
    room.phase = 'stage-intro';
    io.to(roomId).emit('stage-intro', {
      stageName: currentStage(room).name,
      stageTopic: currentStage(room).topic || '',
      stageDescription: currentStage(room).description || '',
      stageNumber: room.stageIndex + 1,
      stageCount: game.stages.length
    });
    return res.json({ phase: 'stage-intro' });
  }

  if (room.phase === 'question') {
    // A hints question shows its hints one by one before moving on.
    const entry = room.questionHistory[room.questionIndex];
    if (entry && entry.type === 'hints' && entry.revealedHints < entry.hints.length) {
      entry.revealedHints++;
      broadcastHints(room, roomId, room.questionIndex);
      return res.json({ phase: 'question' });
    }
    // Otherwise on to a new question — after the furthest one shown, even
    // while the host is back on an earlier one — or, past the stage's last,
    // to its answers.
    if (navigateTo(room, roomId, room.questionHistory.length))
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
      room.leaderboardView = 'game';
      io.to(roomId).emit('leaderboard', finalLeaderboardPayload(room));
      return res.json({ phase: 'finished' });
    }

    room.phase = 'stage-intro';
    io.to(roomId).emit('stage-intro', {
      stageName: currentStage(room).name,
      stageTopic: currentStage(room).topic || '',
      stageDescription: currentStage(room).description || '',
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
// active season's standings ('season') or penalty points ('penalties').
app.post('/api/host/room/:roomId/leaderboard-view', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  const view = req.body.view;
  if (!['game', 'season', 'penalties'].includes(view))
    return res.status(400).json({ error: 'Nežinomas rodinys' });
  if (room.phase !== 'finished' || (view !== 'game' && !room.seasonId))
    return res.status(400).json({ error: 'Sezono taškų parodyti negalima' });
  room.leaderboardView = view;
  io.to(roomId).emit('leaderboard', finalLeaderboardPayload(room));
  res.json({ view });
});

// Host's − / + beside a team in the team status list: one penalty point
// more or less for the room's season (never below 0).
app.post('/api/host/room/:roomId/penalty', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  if (!room.seasonId)
    return res.status(400).json({ error: 'Kambarys be sezono' });
  const { teamId, delta } = req.body;
  if (delta !== 1 && delta !== -1)
    return res.status(400).json({ error: 'Netinkamas pokytis' });
  const teams = loadTeams();
  const team = teams[teamId];
  if (!team || !room.joinedTeams.has(teamId))
    return res.status(404).json({ error: 'Komanda nerasta' });
  const penalty = Math.max(0, seasonPenalty(team, room.seasonId) + delta);
  team.penalties = team.penalties || {};
  team.penalties[room.seasonId] = penalty;
  saveTeams(teams);
  console.log(`[nuobaudos] ${team.name}: ${penalty} (sezonas ${room.seasonId})`);
  emitTeamStatus(roomId);
  if (room.phase === 'finished' && room.leaderboardView === 'penalties')
    io.to(roomId).emit('leaderboard', finalLeaderboardPayload(room));
  res.json({ penalty });
});

// Whether a paper team's stage points can still be changed: only for a
// stage not yet recorded — up to its answers; once its results are shown,
// they're in the team's history.
function paperPointsEditable(room) {
  return ['stage-intro', 'question', 'stage-answers'].includes(room.phase);
}

// Host adds a team playing on paper: one already registered (teamId) or a
// new one by name (reusing a registered team with that name, if any). It
// joins the room like any other team — in the standings, penalties and
// history — just without a phone.
app.post('/api/host/room/:roomId/offline-team', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  if (room.phase === 'finished')
    return res.status(400).json({ error: 'Žaidimas jau baigtas' });
  const teams = loadTeams();
  let teamId = typeof req.body.teamId === 'string' ? req.body.teamId : '';
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (teamId) {
    if (!teams[teamId]) return res.status(404).json({ error: 'Komanda nerasta' });
  } else {
    if (!name) return res.status(400).json({ error: 'Įvesk komandos pavadinimą' });
    const existing = Object.entries(teams).find(
      ([, t]) => t.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) teamId = existing[0];
    else {
      teamId = generateId(teams);
      teams[teamId] = { name: name.slice(0, 60) };
      saveTeams(teams);
    }
  }
  if (room.joinedTeams.has(teamId))
    return res.status(400).json({ error: 'Ši komanda jau žaidžia' });
  room.joinedTeams.add(teamId);
  room.offlineTeams.add(teamId);
  emitTeamStatus(roomId);
  res.json({ teamId });
});

// Host sets the points a paper team scored in the current stage — they go
// onto its running total (replacing what was entered before), so the
// stage's results and history count them like any other points.
app.post('/api/host/room/:roomId/paper-points', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  const { teamId, points } = req.body;
  if (!room.offlineTeams.has(teamId))
    return res.status(404).json({ error: 'Komanda nerasta' });
  if (!paperPointsEditable(room))
    return res.status(400).json({ error: 'Šio etapo taškai jau įrašyti' });
  if (!Number.isInteger(points) || points < 0 || points > 999)
    return res.status(400).json({ error: 'Netinkamas taškų skaičius' });
  const stagePoints = (room.paperScores[room.stageIndex] =
    room.paperScores[room.stageIndex] || {});
  room.scores[teamId] =
    (room.scores[teamId] || 0) - (stagePoints[teamId] || 0) + points;
  stagePoints[teamId] = points;
  emitTeamStatus(roomId);
  res.json({ points });
});

// Host takes a team out of the room (e.g. joined by mistake, under a wrong
// name): it's gone from the team list and the standings, and whatever it
// answered no longer counts. Its phone is sent back to the join page.
app.delete('/api/host/room/:roomId/teams/:teamId', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Kambarys nerastas' });
  const teamId = req.params.teamId;
  if (!room.joinedTeams.has(teamId))
    return res.status(404).json({ error: 'Komanda nerasta' });
  room.joinedTeams.delete(teamId);
  room.offlineTeams.delete(teamId);
  delete room.internetStatus[teamId];
  delete room.scores[teamId];
  delete room.priorScores[teamId];
  Object.values(room.paperScores).forEach((stage) => delete stage[teamId]);
  room.questionHistory.forEach((entry) => {
    if (!entry) return;
    ['selections', 'bonusSelections', 'textOverrides', 'bonusOverrides', 'locks', 'awardedPoints'].forEach(
      (key) => entry[key] && delete entry[key][teamId]
    );
  });
  if (room.leaderboard)
    room.leaderboard = room.leaderboard.filter((row) => row.teamId !== teamId);
  for (const [, s] of io.sockets.sockets) {
    if (s.data.roomId !== roomId || s.data.teamId !== teamId) continue;
    s.emit('team-removed');
    s.leave(roomId);
    s.data.roomId = null;
    s.data.teamId = null;
  }
  emitTeamStatus(roomId);
  res.json({ ok: true });
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

// Every team that joined the room: whether its phone is connected right now,
// its last internet check (online, and how long ago — the host page treats
// an old check as unknown) and its penalty points this season (null when
// the room has no season, so there's nowhere to keep them) — or, for a team
// playing on paper, the points entered for it this stage. Plus every
// registered team not in the room, to add one playing on paper.
function teamStatusPayload(roomId) {
  const room = rooms[roomId];
  const teams = loadTeams();
  const connected = new Set();
  for (const [, s] of io.sockets.sockets) {
    if (s.connected && s.data.roomId === roomId && s.data.teamId)
      connected.add(s.data.teamId);
  }
  const now = Date.now();
  const list = Array.from(room.joinedTeams)
    .map((teamId) => {
      const status = room.internetStatus[teamId];
      return {
        teamId,
        name: teams[teamId] ? teams[teamId].name : teamId,
        connected: connected.has(teamId),
        online: status ? status.online : null,
        checkedAgoMs: status ? now - status.at : null,
        penalty: room.seasonId ? seasonPenalty(teams[teamId], room.seasonId) : null,
        offline: room.offlineTeams.has(teamId),
        paperPoints: (room.paperScores[room.stageIndex] || {})[teamId] || 0
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'lt'));
  const available = Object.entries(teams)
    .filter(([teamId]) => !room.joinedTeams.has(teamId))
    .map(([teamId, t]) => ({ teamId, name: t.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'lt'));
  return {
    teams: list,
    available,
    paperEditable: paperPointsEditable(room),
    canAdd: room.phase !== 'finished'
  };
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
      // A team added to play on paper that turns up with a phone after all.
      room.offlineTeams.delete(teamId);
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
    } else if (room.phase === 'game-rules') {
      socket.emit('game-rules', { rules: games[room.gameId].rules });
    } else if (room.phase === 'stage-intro') {
      socket.emit('stage-intro', {
        stageName: currentStage(room).name,
        stageTopic: currentStage(room).topic || '',
        stageDescription: currentStage(room).description || '',
        stageNumber: room.stageIndex + 1,
        stageCount: games[room.gameId].stages.length
      });
    } else if (room.phase === 'question' && room.questionIndex >= 0) {
      socket.emit('question', questionPayloadFor(room, teamId));
    }
    // The view screen's text size (players' phones ignore it).
    if (!teamId) socket.emit('text-scale', { scale: textScalePercent(room) });
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
  // The value is the picked option's id, for a typed-answer question the
  // typed string, or for a chain an array of typed strings, one per clue.
  // 'select-bonus' is the same for the extra answer's typed string.
  function answerTarget(index) {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'question' || room.questionIndex < 0) return null;
    if (!socket.data.teamId) return null;
    const targetIndex = Number.isInteger(index) ? index : room.questionIndex;
    const entry = room.questionHistory[targetIndex];
    return entry ? { room, targetIndex, entry } : null;
  }

  socket.on('select', (value, index) => {
    const target = answerTarget(index);
    if (!target) return;
    const { room, targetIndex, entry } = target;
    const teamId = socket.data.teamId;
    let selection;
    const fieldCount =
      entry.type === 'chain'
        ? entry.clues.length
        : entry.type === 'text' && entry.answerCount > 1
          ? entry.answerCount
          : 0;
    if (fieldCount) {
      if (!Array.isArray(value)) return;
      selection = Array.from({ length: fieldCount }, (_, i) =>
        typeof value[i] === 'string' ? value[i].slice(0, 200) : ''
      );
    } else if (typeof value !== 'string') {
      return;
    } else if (entry.type === 'text' || entry.type === 'hints') {
      if (entry.type === 'hints' && teamId in entry.locks) return;
      selection = value.slice(0, 200);
    } else {
      if (!entry.options.some((o) => o.id === value)) return;
      selection = value;
    }

    updateEntry(room, targetIndex, () => {
      // A changed typed answer drops the host's earlier call on the old one.
      if (JSON.stringify(entry.selections[teamId]) !== JSON.stringify(selection))
        delete entry.textOverrides[teamId];
      entry.selections[teamId] = selection;
    });
  });

  // Locks a hints question's typed answer in (sent along, so the last few
  // keystrokes still waiting to be sent aren't lost) for the points it's
  // worth right now — it can't be changed after that. Answers the phone
  // with those points, or an error.
  socket.on('lock-answer', (value, index, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const target = answerTarget(index);
    if (!target || target.entry.type !== 'hints' || typeof value !== 'string')
      return reply({ error: 'Atsakymo užrakinti nepavyko' });
    const { room, targetIndex, entry } = target;
    const teamId = socket.data.teamId;
    if (teamId in entry.locks) return reply({ points: entry.locks[teamId] });
    const selection = value.slice(0, 200).trim();
    if (!selection) return reply({ error: 'Pirma įrašyk atsakymą' });
    updateEntry(room, targetIndex, () => {
      if (entry.selections[teamId] !== selection)
        delete entry.textOverrides[teamId];
      entry.selections[teamId] = selection;
      entry.locks[teamId] = hintPoints(entry);
    });
    reply({ points: entry.locks[teamId] });
  });

  socket.on('select-bonus', (value, index) => {
    const target = answerTarget(index);
    if (!target || typeof value !== 'string') return;
    const { room, targetIndex, entry } = target;
    if (entry.bonusAnswer == null) return;
    const teamId = socket.data.teamId;
    const selection = value.slice(0, 200);
    updateEntry(room, targetIndex, () => {
      if (entry.bonusSelections[teamId] !== selection)
        delete entry.bonusOverrides[teamId];
      entry.bonusSelections[teamId] = selection;
    });
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

    // Picture URLs, never as an alt any text (a question's or an option's)
    // that could give an answer away. A grid's text cell (a text option or
    // clue among pictures, already on the view screen) has its text.
    const out = { action };
    if (action === 'image') {
      out.src = (payload.src || '').toString();
    } else if (action === 'options') {
      out.images = Array.isArray(payload.images)
        ? payload.images
            .slice(0, 20)
            .map((i) => {
              const image = { src: ((i && i.src) || '').toString() };
              if (!image.src) image.text = ((i && i.text) || '').toString().slice(0, 500);
              // A chain clue's number (see chainClueImages) — digits only,
              // so no text can ride along.
              const label = ((i && i.label) || '').toString();
              if (/^\d{1,2}$/.test(label)) image.label = label;
              return image;
            })
        : [];
    }
    io.to(roomId).emit('fullscreen-command', out);
  });
});

// History recorded before game and stage names were kept with it gets them
// now, while those games are still there to take them from.
rememberAllHistoryNames();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Quiz server running on http://0.0.0.0:${PORT}`);
  let announcedUrl = joinUrl();
  console.log('Players join at: ' + announcedUrl);
  if (!process.env.LAN_IP) {
    // The startup line goes stale if the hotspot is switched on (or off)
    // later, so print the new address whenever it changes.
    setInterval(() => {
      const url = joinUrl();
      if (url === announcedUrl) return;
      announcedUrl = url;
      console.log('Network changed — players join at: ' + url);
    }, 3000).unref();
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
