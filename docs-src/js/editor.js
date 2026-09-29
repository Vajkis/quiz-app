const params = new URLSearchParams(window.location.search);
const gameId = params.get('id');

const titleEl = document.getElementById('editor-title');
const nameInput = document.getElementById('game-name-input');
const stagesContainer = document.getElementById('stages-container');
const addStageBtn = document.getElementById('add-stage-btn');
const saveBtn = document.getElementById('save-game-btn');
const exportBtn = document.getElementById('export-game-btn');
const importInput = document.getElementById('import-game-input');
const errorEl = document.getElementById('editor-error');

const { createStageCard, renderGame, collectPayload } = QuizGameEditorCore;
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

async function showGame(game) {
  await QuizMediaPreview.load(game);
  renderGame(stagesContainer, nameInput, game);
}

const initialGame = gameId ? QuizGameStorage.getGame(gameId) : null;
if (gameId && !initialGame) {
  errorEl.textContent = 'Žaidimas nerastas šios naršyklės atmintyje';
}
titleEl.textContent = gameId ? 'Redaguoti žaidimą' : 'Naujas žaidimas';
showGame(initialGame);

addStageBtn.addEventListener('click', () => {
  stagesContainer.appendChild(createStageCard({}));
});

saveBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const result = normalizeGamePayload(collectPayload(stagesContainer, nameInput));
  if (result.error) {
    errorEl.textContent = result.error;
    return;
  }

  const id = gameId || QuizGameStorage.newId();
  QuizGameStorage.upsertGame(id, result.game);
  // Files this game no longer uses (e.g. a replaced picture) are dropped.
  await QuizMediaStore.removeUnused(Object.values(QuizGameStorage.loadAll())).catch(() => {});
  window.location.href = 'index.html';
});

exportBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const result = normalizeGamePayload(collectPayload(stagesContainer, nameInput));
  if (result.error) {
    errorEl.textContent = result.error;
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
