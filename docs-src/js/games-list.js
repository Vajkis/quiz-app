const listEl = document.getElementById('game-list');
const errorEl = document.getElementById('games-error');
const exportAllBtn = document.getElementById('export-all-btn');
const importInput = document.getElementById('import-games-input');

// "Bendros taisyklės": the rules every new game starts with (see
// editor.js), saved in this browser as they're edited.
QuizGameEditorCore.mountDefaultRules(
  document.getElementById('default-rules'),
  QuizGameStorage.loadDefaultRules(),
  (rules) => QuizGameStorage.saveDefaultRules(rules),
  document.getElementById('default-rules-status')
);

const draftsSection = document.getElementById('drafts-section');
const draftListEl = document.getElementById('draft-list');

// Games still being written (see storage.js), newest first, above the
// saved ones. A draft is whatever the editor had, so any part of it may be
// missing.
function renderDrafts() {
  const drafts = Object.entries(QuizGameStorage.loadDrafts()).sort(
    ([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
  draftListEl.innerHTML = '';
  draftsSection.hidden = !drafts.length;

  drafts.forEach(([id, d]) => {
    const g = d.game || {};
    const stages = Array.isArray(g.stages) ? g.stages : [];
    const questionCount = stages.reduce(
      (n, s) => n + ((s && Array.isArray(s.questions) && s.questions.length) || 0),
      0
    );

    const row = document.createElement('div');
    row.className = 'room-row draft-row';
    row.innerHTML = `
      <a class="option" href="editor.html?draft=${encodeURIComponent(id)}"></a>
      <button type="button" class="room-close-btn draft-delete-btn" title="Ištrinti juodraštį">${QuizIcons.icon('close')}</button>
    `;
    row.querySelector('a').textContent = `${g.name || 'Be pavadinimo'} (${stages.length} etapai, ${questionCount} klausimai)`;
    row.querySelector('.draft-delete-btn').addEventListener('click', () => {
      if (!confirm('Ištrinti šį juodraštį?')) return;
      QuizGameStorage.deleteDraft(id);
      QuizMediaStore.removeUnused(QuizGameStorage.allGamesAndDrafts()).catch(() => {});
      renderDrafts();
    });
    draftListEl.appendChild(row);
  });
}

function render() {
  errorEl.textContent = '';
  renderDrafts();
  const games = QuizGameStorage.loadAll();
  // Newest first: games are kept in the order they were created (saving an
  // edit doesn't move one), so that order reversed.
  const ids = Object.keys(games).reverse();
  listEl.innerHTML = '';

  if (!ids.length) {
    const p = document.createElement('p');
    p.className = 'hint-text';
    p.textContent = 'Kol kas nėra sukurtų žaidimų.';
    listEl.appendChild(p);
    return;
  }

  ids.forEach((id) => {
    const g = games[id];
    const stageCount = g.stages.length;
    const questionCount = g.stages.reduce((n, s) => n + s.questions.length, 0);

    const row = document.createElement('div');
    row.className = 'room-row';
    row.innerHTML = `
      <a class="option" href="editor.html?id=${encodeURIComponent(id)}">${g.name} (${stageCount} etapai, ${questionCount} klausimai)</a>
      <a class="room-close-btn game-preview-btn" href="preview.html?id=${encodeURIComponent(id)}" title="Peržiūrėti žaidimą">${QuizIcons.icon('play')}</a>
      <button type="button" class="room-close-btn game-export-btn" title="Eksportuoti žaidimą">${QuizIcons.icon('download')}</button>
      <button type="button" class="room-close-btn game-delete-btn" title="Ištrinti žaidimą">${QuizIcons.icon('close')}</button>
    `;
    row.querySelector('.game-export-btn').addEventListener('click', () => {
      // .zip if the game has files picked here (see game-files.js).
      QuizGameFiles.exportGames(QuizGameShared.extractGamesFromImport(g).games, 'zaidimas').catch(() => {
        errorEl.textContent = 'Nepavyko eksportuoti žaidimo';
      });
    });
    row.querySelector('.game-delete-btn').addEventListener('click', () => {
      if (!confirm('Ištrinti šį žaidimą?')) return;
      QuizGameStorage.deleteGame(id);
      QuizMediaStore.removeUnused(QuizGameStorage.allGamesAndDrafts()).catch(() => {});
      render();
    });
    listEl.appendChild(row);
  });
}

exportAllBtn.addEventListener('click', () => {
  const games = QuizGameStorage.loadAll();
  if (!Object.keys(games).length) {
    errorEl.textContent = 'Nėra žaidimų eksportavimui';
    return;
  }
  // A plain list — no ids (see game-shared.js); the local storage keys stay
  // local. A .zip if any game has files picked here (see game-files.js).
  QuizGameFiles.exportGames(QuizGameShared.extractGamesFromImport(Object.values(games)).games, 'zaidimai').catch(() => {
    errorEl.textContent = 'Nepavyko eksportuoti žaidimų';
  });
});

importInput.addEventListener('change', async () => {
  errorEl.textContent = '';
  const files = Array.from(importInput.files);
  importInput.value = '';
  if (!files.length) return;

  let imported = 0;
  const errors = [];

  for (const file of files) {
    // .json or .zip (whose files go into this browser's media store).
    const result = await QuizGameFiles.importFile(file);
    if (result.error) {
      errors.push(`${file.name}: ${result.error}`);
      continue;
    }

    for (const game of result.games) {
      // Stored without any ids from the file, under a fresh local key.
      QuizGameStorage.upsertGame(QuizGameStorage.newId(), game);
      imported++;
    }
  }

  if (errors.length) errorEl.textContent = errors.join('; ');
  if (imported) render();
});

render();
