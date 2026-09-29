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

  function newId() {
    return QuizGameShared.generateId(loadAll());
  }

  global.QuizGameStorage = { loadAll, saveAll, getGame, upsertGame, deleteGame, newId };
})(window);
