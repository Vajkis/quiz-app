// "Bendros taisyklės": the rules every new game starts with (see
// /host/games/new), saved to the server as they're edited.
QuizGameEditorCore.mountDefaultRules(
  document.getElementById('default-rules'),
  JSON.parse(document.getElementById('default-rules-data').textContent),
  async (rules) => {
    const res = await fetch('/api/host/default-rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
      keepalive: true,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Nepavyko išsaugoti taisyklių');
  },
  document.getElementById('default-rules-status')
);

document.querySelectorAll('.game-delete-btn').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm('Ištrinti šį žaidimą?')) return;

    const res = await fetch(`/api/games/${btn.dataset.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      alert(data.error || 'Nepavyko ištrinti žaidimo');
      return;
    }

    btn.closest('.room-row').remove();
  });
});

document.querySelectorAll('.draft-delete-btn').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm('Ištrinti šį juodraštį?')) return;

    const res = await fetch(`/api/host/drafts/${btn.dataset.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      alert(data.error || 'Nepavyko ištrinti juodraščio');
      return;
    }

    btn.closest('.room-row').remove();
    // the last draft gone: its heading and the divider under it go too
    const section = document.getElementById('drafts-section');
    if (section && !section.querySelector('.draft-row')) section.remove();
  });
});

// ⭳ per game and "Eksportuoti visus": fetched from the server as stored
// (with ids and the correct option named by id), turned portable — no ids,
// correct option first, like every exported file — and exported as .json,
// or .zip if they have files of their own (see game-export.js). Import
// errors show in the same place.
const fileErrorEl = document.getElementById('games-file-error');

async function exportByIds(ids, baseName, btn) {
  fileErrorEl.hidden = true;
  btn.disabled = true;
  try {
    const stored = [];
    for (const id of ids) {
      const res = await fetch(`/api/games/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('Nepavyko gauti žaidimo');
      stored.push(await res.json());
    }
    const result = QuizGameShared.extractGamesFromImport(stored);
    if (result.error) throw new Error(result.error);
    await QuizGameExport.exportGames(result.games, baseName);
  } catch (err) {
    fileErrorEl.textContent = err.message || 'Nepavyko eksportuoti';
    fileErrorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

document.querySelectorAll('.game-export-btn').forEach((btn) => {
  btn.addEventListener('click', () => exportByIds([btn.dataset.id], 'zaidimas', btn));
});

const exportAllBtn = document.getElementById('export-all-games-btn');
if (exportAllBtn) {
  exportAllBtn.addEventListener('click', () => {
    // only the rows still on the page — a deleted game's row is gone
    const ids = Array.from(document.querySelectorAll('.game-export-btn')).map((b) => b.dataset.id);
    if (ids.length) exportByIds(ids, 'zaidimai', exportAllBtn);
  });
}

// ⭱ "Importuoti": every game in a .json/.zip file is saved straight away,
// no editor in between. Each one gets an id picked here, so a .zip's files
// can be uploaded into its media folder before the save that claims it —
// the same order the new-game editor uses (see POST /api/games, which picks
// another id if this one is somehow taken; the files still work from here).
const importInput = document.getElementById('import-games-input');
const importBtn = document.getElementById('import-games-btn');

async function uploadMedia(file, gameId) {
  const res = await fetch(`/api/host/upload?gameId=${encodeURIComponent(gameId)}`, {
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
}

// Swaps each "media:<id>/<name>" reference for its uploaded file's address,
// like the editor's uploadZipMedia; one with no file in the zip is left for
// the save to reject.
async function uploadZipMedia(game, zipFiles, gameId) {
  const urls = new Map();
  for (const ref of QuizGameMediaZip.collectMediaRefs([game])) {
    const blob = zipFiles.get(ref);
    if (!blob) continue;
    const name = QuizGameMediaZip.mediaRefFileName(ref);
    urls.set(ref, await uploadMedia(new File([blob], name, { type: blob.type }), gameId));
  }
  return QuizGameMediaZip.mapMediaFields(game, (value) => urls.get(value) || value);
}

async function importGame(game, zipFiles) {
  const gameId = QuizGameShared.generateId(null);
  const withMedia = await uploadZipMedia(game, zipFiles, gameId);
  const res = await fetch('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...withMedia, id: gameId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Nepavyko išsaugoti žaidimo');
}

if (importInput) {
  importInput.addEventListener('change', async () => {
    fileErrorEl.hidden = true;
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;

    const isZip = QuizGameMediaZip.isZipFile(file);
    let parsed;
    let zipFiles = new Map();
    try {
      if (isZip) {
        const zip = await QuizGameMediaZip.readZip(file);
        parsed = zip.parsed;
        zipFiles = zip.files;
      } else {
        parsed = JSON.parse(await file.text());
      }
    } catch (err) {
      fileErrorEl.textContent = isZip ? err.message || 'Netinkamas zip failas' : 'Netinkamas JSON failas';
      fileErrorEl.hidden = false;
      return;
    }

    const result = QuizGameShared.extractGamesFromImport(parsed);
    if (result.error) {
      fileErrorEl.textContent = result.error;
      fileErrorEl.hidden = false;
      return;
    }

    importBtn.classList.add('is-busy');
    const failed = [];
    for (const game of result.games) {
      try {
        await importGame(game, zipFiles);
      } catch (err) {
        failed.push(`„${game.name || 'be pavadinimo'}“: ${err.message}`);
      }
    }
    importBtn.classList.remove('is-busy');

    if (!failed.length) {
      window.location.reload();
      return;
    }
    const imported = result.games.length - failed.length;
    fileErrorEl.textContent =
      `Importuota ${imported} iš ${result.games.length}. Nepavyko: ${failed.join('; ')}` +
      (imported ? ' (atnaujink puslapį, kad pamatytum importuotus)' : '');
    fileErrorEl.hidden = false;
  });
}
