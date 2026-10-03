const gameId = document.body.dataset.gameId || null;
// Whose media folder uploads go in (data/media/<id>/): this game's, or —
// for a game not saved yet — the id the server reserved for it, which the
// first save then asks for (see POST /api/games).
const mediaGameId = gameId || document.body.dataset.newGameId || '';
const nameInput = document.getElementById('game-name-input');
const stagesContainer = document.getElementById('stages-container');
const addStageBtn = document.getElementById('add-stage-btn');
const saveBtn = document.getElementById('save-game-btn');
const exportBtn = document.getElementById('export-game-btn');
const importInput = document.getElementById('import-game-input');
const errorEl = document.getElementById('editor-error');

// The 📁 buttons: on the server's own computer they open its Windows file
// dialog and fill in the picked file's real path (see /api/host/pick-file);
// from any other device the file is uploaded instead (/api/host/upload) and
// the field gets its address. Set before any card is rendered — cards only
// get the button if one of these exists.
if (document.body.dataset.nativeFilePicker === 'true') {
  QuizGameEditorCore.pickLocalFile = async (kind) => {
    const res = await fetch('/api/host/pick-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Nepavyko pasirinkti failo');
    return data.path;
  };
}

QuizGameEditorCore.uploadFile = async (file) => {
  const query = mediaGameId ? `?gameId=${encodeURIComponent(mediaGameId)}` : '';
  const res = await fetch(`/api/host/upload${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Nepavyko įkelti failo');
  return data.url;
};

const { addStage, renderGame, collectPayload } = QuizGameEditorCore;
const { normalizeGamePayload, extractGamesFromImport } = QuizGameShared;

addStageBtn.addEventListener('click', () => {
  addStage(stagesContainer);
});

const initialDataEl = document.getElementById('game-data');
const initialGame = initialDataEl
  ? JSON.parse(initialDataEl.textContent)
  : null;
renderGame(stagesContainer, nameInput, initialGame);
QuizGameEditorCore.mountSidePanel(stagesContainer);
QuizGameEditorCore.addDefaultRulesButton(
  stagesContainer,
  JSON.parse(document.getElementById('default-rules-data').textContent)
);

// A new game is saved as a draft while it's filled in (see PUT
// /api/host/drafts): nothing checked, so a half-made one is kept too. It's
// saved under the id reserved for the game, and "Išsaugoti žaidimą" (which
// checks everything, as before) turns it into a game and deletes the draft.
// Editing a saved game has no draft — it's saved with its own button only.
const draftStatusEl = document.getElementById('draft-status');
let draftSaved = document.body.dataset.draft === 'true';
let gameSaved = false;
// What the form holds untouched: until it changes, there's no draft yet.
const blankJson = JSON.stringify(collectPayload(stagesContainer, nameInput));
let lastDraftJson = blankJson;

// Going back: a saved game's changes would be lost; a new game (or a draft)
// would stay just a draft, not a game.
QuizGameEditorCore.guardBackLink(() => {
  const json = JSON.stringify(collectPayload(stagesContainer, nameInput));
  if (gameId)
    return json !== blankJson ? 'Pakeitimai neišsaugoti. Ar tikrai nori išeiti?' : null;
  return draftSaved || json !== blankJson
    ? 'Žaidimas dar neišsaugotas – liks tik juodraštis. Ar tikrai nori išeiti?'
    : null;
});
let draftTimer = null;
let draftRequest = null;

function setDraftStatus(text) {
  if (draftStatusEl) draftStatusEl.textContent = text;
}

function saveDraft({ keepalive = false } = {}) {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (gameId || gameSaved) return Promise.resolve();
  const json = JSON.stringify(collectPayload(stagesContainer, nameInput));
  if (json === lastDraftJson) return draftRequest || Promise.resolve();
  lastDraftJson = json;

  setDraftStatus('Saugomas juodraštis…');
  draftRequest = fetch(`/api/host/drafts/${encodeURIComponent(mediaGameId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: json,
    keepalive,
  })
    .then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Nepavyko išsaugoti juodraščio');
      }
      // From now on this page is the draft's own — a reload opens it again.
      if (!draftSaved) {
        draftSaved = true;
        history.replaceState(null, '', `/host/drafts/${encodeURIComponent(mediaGameId)}/edit`);
      }
      setDraftStatus('Juodraštis išsaugotas');
    })
    .catch((err) => {
      lastDraftJson = null; // try again on the next change
      setDraftStatus(err.message || 'Nepavyko išsaugoti juodraščio');
    });
  return draftRequest;
}

function scheduleDraftSave() {
  if (gameId || gameSaved) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 800);
}

if (!gameId) {
  const editorEl = document.getElementById('game-editor');
  // Typing, and everything else that changes the game without an input
  // event: added/removed/moved cards, Taip/Ne buttons, an import.
  ['input', 'change', 'click'].forEach((type) => editorEl.addEventListener(type, scheduleDraftSave));
  new MutationObserver(scheduleDraftSave).observe(editorEl, { childList: true, subtree: true });
  // Leaving before the delay's up still saves what was typed last.
  window.addEventListener('pagehide', () => {
    if (draftTimer) saveDraft({ keepalive: true });
  });
}

saveBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const payload = collectPayload(stagesContainer, nameInput);
  if (!gameId) {
    payload.id = mediaGameId;
    // Let a draft save still on its way land first, or it would bring the
    // draft back after the game's save deleted it.
    await saveDraft();
  }

  const url = gameId ? `/api/games/${gameId}` : '/api/games';
  const method = gameId ? 'PUT' : 'POST';

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if (!res.ok) {
    errorEl.textContent = data.error || 'Nepavyko išsaugoti žaidimo';
    QuizGameEditorCore.markStageErrors(stagesContainer, nameInput);
    return;
  }

  gameSaved = true; // the server deleted the draft; don't save it again
  clearTimeout(draftTimer);
  window.location.href = '/host/games';
});

exportBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const result = normalizeGamePayload(
    collectPayload(stagesContainer, nameInput)
  );
  if (result.error) {
    errorEl.textContent = result.error;
    QuizGameEditorCore.markStageErrors(stagesContainer, nameInput);
    return;
  }

  // Portable, id-less file (see game-shared.js) — importing it anywhere gets fresh ids.
  exportBtn.disabled = true;
  try {
    // .zip if it has files of its own (see game-export.js)
    await QuizGameExport.exportGames([result.game], 'zaidimas');
  } catch (err) {
    errorEl.textContent = err.message || 'Nepavyko eksportuoti žaidimo';
  } finally {
    exportBtn.disabled = false;
  }
});

importInput.addEventListener('change', async () => {
  errorEl.textContent = '';
  const file = importInput.files[0];
  importInput.value = '';
  if (!file) return;

  // A .zip (from the GitHub Pages editor, see game-media-zip.js) carries
  // the game's picture/music files too; they're uploaded below.
  let parsed;
  let zipFiles = new Map();
  try {
    if (QuizGameMediaZip.isZipFile(file)) {
      const zip = await QuizGameMediaZip.readZip(file);
      parsed = zip.parsed;
      zipFiles = zip.files;
    } else {
      parsed = JSON.parse(await file.text());
    }
  } catch (err) {
    errorEl.textContent = QuizGameMediaZip.isZipFile(file) ? err.message || 'Netinkamas zip failas' : 'Netinkamas JSON failas';
    return;
  }

  const result = extractGamesFromImport(parsed);
  if (result.error) {
    errorEl.textContent = result.error;
    return;
  }

  const game =
    result.games.length > 1
      ? await QuizGameEditorCore.chooseImportGame(result.games, document.querySelector('.editor-actions'))
      : result.games[0];
  if (!game) return; // "Atšaukti"

  try {
    renderGame(stagesContainer, nameInput, await uploadZipMedia(game, zipFiles));
  } catch (err) {
    errorEl.textContent = err.message || 'Nepavyko įkelti žaidimo failų';
  }
});

// Uploads each file a .zip'd game references ("media:<id>/<name>") and
// swaps the reference for the address the server keeps it at. A reference
// with no file in the zip is left for the save to reject.
async function uploadZipMedia(game, zipFiles) {
  const urls = new Map();
  for (const ref of QuizGameMediaZip.collectMediaRefs([game])) {
    const blob = zipFiles.get(ref);
    if (!blob) continue;
    const name = QuizGameMediaZip.mediaRefFileName(ref);
    urls.set(ref, await QuizGameEditorCore.uploadFile(new File([blob], name, { type: blob.type })));
  }
  return QuizGameMediaZip.mapMediaFields(game, (value) => urls.get(value) || value);
}
