// Persists games in this browser's localStorage as { key: game }. The keys
// are local bookkeeping only (which game the editor page is open on) —
// they never end up in a game or an exported file, which carry no ids at
// all; the main app creates ids when it imports a game. Storage is
// per-browser/device; export is how games move to another device or into
// the main app.
(function (global) {
  const STORAGE_KEY = 'quizAppGames';

  function loadAll() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveAll(games) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
  }

  function getGame(id) {
    return loadAll()[id] || null;
  }

  function upsertGame(id, game) {
    const all = loadAll();
    all[id] = game;
    saveAll(all);
    return id;
  }

  function deleteGame(id) {
    const all = loadAll();
    delete all[id];
    saveAll(all);
  }

  // New games being written, as { key: { game, updatedAt } }: the editor
  // saves one here as it's filled in — as-is, nothing checked — and saving
  // it as a game deletes it. Kept apart from the games, like the main app's
  // data/drafts.json.
  const DRAFTS_KEY = 'quizAppDrafts';

  function loadDrafts() {
    try {
      return JSON.parse(localStorage.getItem(DRAFTS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function getDraft(id) {
    const draft = loadDrafts()[id];
    return draft ? draft.game : null;
  }

  function saveDraft(id, game) {
    const all = loadDrafts();
    all[id] = { game, updatedAt: Date.now() };
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
  }

  function deleteDraft(id) {
    const all = loadDrafts();
    delete all[id];
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
  }

  // "Bendros taisyklės": the rules every new game starts with, set on the
  // games list. A game gets a copy when it's created — changing them later
  // doesn't touch games already made.
  const RULES_KEY = 'quizAppDefaultRules';

  function loadDefaultRules() {
    try {
      const rules = JSON.parse(localStorage.getItem(RULES_KEY));
      return Array.isArray(rules) ? rules : [];
    } catch {
      return [];
    }
  }

  function saveDefaultRules(rules) {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  }

  // Every game and draft — what the media store must keep files for.
  function allGamesAndDrafts() {
    return [...Object.values(loadAll()), ...Object.values(loadDrafts()).map((d) => d.game)];
  }

  // Unused by a game or a draft, so a draft saved as a game can keep its key.
  function newId() {
    return QuizGameShared.generateId({ ...loadAll(), ...loadDrafts() });
  }

  global.QuizGameStorage = {
    loadAll,
    saveAll,
    getGame,
    upsertGame,
    deleteGame,
    newId,
    loadDrafts,
    getDraft,
    saveDraft,
    deleteDraft,
    allGamesAndDrafts,
    loadDefaultRules,
    saveDefaultRules,
  };
})(window);
