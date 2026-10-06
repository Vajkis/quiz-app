const params = new URLSearchParams(window.location.search);
const gameId = params.get('id');
// A new game's key, reserved as soon as the page opens: its draft is saved
// under it while it's filled in, and the game too once it's saved.
let draftId = gameId ? null : params.get('draft');
const openedDraft = !!draftId;
if (!gameId && !draftId) draftId = QuizGameStorage.newId();

const titleEl = document.getElementById('editor-title');
const nameInput = document.getElementById('game-name-input');
const stagesContainer = document.getElementById('stages-container');
const addStageBtn = document.getElementById('add-stage-btn');
const saveBtn = document.getElementById('save-game-btn');
const exportBtn = document.getElementById('export-game-btn');
const importInput = document.getElementById('import-game-input');
const errorEl = document.getElementById('editor-error');
const draftStatusEl = document.getElementById('draft-status');

const { addStage, renderGame, collectPayload } = QuizGameEditorCore;
const { normalizeGamePayload } = QuizGameShared;

// 📁 buttons: the picked file is kept in this browser (media-store.js) and
// the field gets a "media:..." reference to it — a browser never reveals a
// file's real path, and this site has no server to upload to. Exporting the
// game then packs the files into a .zip with it. Set before any card is
// rendered — cards only get the button if this exists.
QuizGameEditorCore.uploadFile = async (file) => {
  const ref = await QuizMediaStore.addFile(file);
  QuizMediaPreview.register(ref, file);
  return ref;
};

QuizGameEditorCore.mountSidePanel(stagesContainer);

async function showGame(game) {
  // A file that can't be read just has no preview — the game still opens
  // (and its draft keeps being saved).
  await QuizMediaPreview.load(game).catch(() => {});
  renderGame(stagesContainer, nameInput, game);
}

let initialGame = null;
if (gameId) {
  initialGame = QuizGameStorage.getGame(gameId);
  if (!initialGame) errorEl.textContent = 'Žaidimas nerastas šios naršyklės atmintyje';
} else if (openedDraft) {
  initialGame = QuizGameStorage.getDraft(draftId);
  if (!initialGame) errorEl.textContent = 'Juodraštis nerastas šios naršyklės atmintyje';
} else {
  // A new game starts with the shared rules (set on the games list), if any.
  const rules = QuizGameStorage.loadDefaultRules();
  if (rules.length) initialGame = { rules };
}
titleEl.textContent = gameId ? 'Redaguoti žaidimą' : openedDraft ? 'Juodraštis' : 'Naujas žaidimas';
if (draftStatusEl) {
  draftStatusEl.hidden = !!gameId;
  draftStatusEl.textContent = openedDraft
    ? 'Juodraštis išsaugotas'
    : 'Pildant žaidimas automatiškai saugomas kaip juodraštis';
}

// A new game is saved as a draft while it's filled in (see storage.js):
// nothing checked, so a half-made one is kept too. "Išsaugoti žaidimą"
// (which checks everything, as before) turns it into a game and deletes
// the draft. Editing a saved game has no draft — it's saved with its own
// button only.
let draftSaved = openedDraft;
let gameSaved = false;
let lastDraftJson = null; // set once the form is rendered
let draftTimer = null;

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (gameId || gameSaved || lastDraftJson === null) return;
  const payload = collectPayload(stagesContainer, nameInput);
  const json = JSON.stringify(payload);
  if (json === lastDraftJson) return;
  try {
    QuizGameStorage.saveDraft(draftId, payload);
  } catch {
    draftStatusEl.textContent = 'Nepavyko išsaugoti juodraščio (pilna naršyklės atmintis?)';
    return;
  }
  lastDraftJson = json;
  // From now on this page is the draft's own — a reload opens it again.
  if (!draftSaved) {
    draftSaved = true;
    history.replaceState(null, '', `editor.html?draft=${encodeURIComponent(draftId)}`);
  }
  draftStatusEl.textContent = 'Juodraštis išsaugotas';
}

// The first change is saved at once, not after the delay: until it is, the
// page has no ?draft=, and a reload would open a blank new game while what
// was typed went into a draft under the old id.
function scheduleDraftSave() {
  if (gameId || gameSaved) return;
  clearTimeout(draftTimer);
  if (!draftSaved) saveDraft();
  else draftTimer = setTimeout(saveDraft, 800);
}

showGame(initialGame).then(() => {
  // A saved game or a draft gets the shared rules only on request (a new
  // game already started with them).
  if (gameId || openedDraft) {
    QuizGameEditorCore.addDefaultRulesButton(stagesContainer, QuizGameStorage.loadDefaultRules());
  }

  // Going back: a saved game's changes would be lost; a new game (or a
  // draft) would stay just a draft, not a game.
  const openedJson = JSON.stringify(collectPayload(stagesContainer, nameInput));
  QuizGameEditorCore.guardBackLink(() => {
    const json = JSON.stringify(collectPayload(stagesContainer, nameInput));
    if (gameId)
      return json !== openedJson ? 'Pakeitimai neišsaugoti. Ar tikrai nori išeiti?' : null;
    return draftSaved || json !== openedJson
      ? 'Žaidimas dar neišsaugotas – liks tik juodraštis. Ar tikrai nori išeiti?'
      : null;
  });

  if (gameId) return;
  // What the form holds untouched: until it changes, there's no draft yet.
  lastDraftJson = JSON.stringify(collectPayload(stagesContainer, nameInput));
  const editorEl = document.getElementById('game-editor');
  // Typing, and everything else that changes the game without an input
  // event: added/removed/moved cards, Taip/Ne buttons, an import.
  ['input', 'change', 'click'].forEach((type) => editorEl.addEventListener(type, scheduleDraftSave));
  new MutationObserver(scheduleDraftSave).observe(editorEl, { childList: true, subtree: true });
  // Leaving before the delay's up still saves what was typed last.
  window.addEventListener('pagehide', () => {
    if (draftTimer) saveDraft();
  });
});

addStageBtn.addEventListener('click', () => {
  addStage(stagesContainer);
});

saveBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const result = normalizeGamePayload(collectPayload(stagesContainer, nameInput));
  if (result.error) {
    errorEl.textContent = result.error;
    QuizGameEditorCore.markStageErrors(stagesContainer, nameInput);
    return;
  }

  const id = gameId || draftId;
  QuizGameStorage.upsertGame(id, result.game);
  if (!gameId) {
    // Saved as a game now, so its draft goes.
    gameSaved = true;
    clearTimeout(draftTimer);
    QuizGameStorage.deleteDraft(draftId);
  }
  // Files no game or draft uses any more (e.g. a replaced picture) are dropped.
  await QuizMediaStore.removeUnused(QuizGameStorage.allGamesAndDrafts()).catch(() => {});
  window.location.href = 'index.html';
});
exportBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const result = normalizeGamePayload(collectPayload(stagesContainer, nameInput));
  if (result.error) {
    errorEl.textContent = result.error;
    QuizGameEditorCore.markStageErrors(stagesContainer, nameInput);
    return;
  }
  // Portable, id-less file (.zip if it has picked files) — the main app
  // creates ids when it imports it.
  try {
    await QuizGameFiles.exportGames([result.game], 'zaidimas');
  } catch (err) {
    errorEl.textContent = 'Nepavyko eksportuoti žaidimo';
  }
});

importInput.addEventListener('change', async () => {
  errorEl.textContent = '';
  const file = importInput.files[0];
  importInput.value = '';
  if (!file) return;

  const result = await QuizGameFiles.importFile(file);
  if (result.error) {
    errorEl.textContent = result.error;
    return;
  }

  const game =
    result.games.length > 1
      ? await QuizGameEditorCore.chooseImportGame(result.games, document.querySelector('.editor-actions'))
      : result.games[0];
  if (!game) return; // "Atšaukti"

  await showGame(game);
});
