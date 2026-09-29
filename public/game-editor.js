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

const { createStageCard, renderGame, collectPayload } = QuizGameEditorCore;
const { normalizeGamePayload, extractGamesFromImport } = QuizGameShared;

addStageBtn.addEventListener('click', () => {
  stagesContainer.appendChild(createStageCard({}));
});

const initialDataEl = document.getElementById('game-data');
const initialGame = initialDataEl
  ? JSON.parse(initialDataEl.textContent)
  : null;
renderGame(stagesContainer, nameInput, initialGame);

saveBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const payload = collectPayload(stagesContainer, nameInput);
  if (!gameId) payload.id = mediaGameId;

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
    return;
  }

  window.location.href = '/host/games';
});

exportBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const result = normalizeGamePayload(
    collectPayload(stagesContainer, nameInput)
  );
  if (result.error) {
    errorEl.textContent = result.error;
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
