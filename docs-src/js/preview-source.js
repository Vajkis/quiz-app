// Where the GitHub Pages preview (preview.js) gets its game: this browser's
// storage, by the ?id= in the address — or from the editor's tab (?editor) —
// with the files picked here with 📁 (IndexedDB, see media-store.js) turned
// into playable object URLs first (prepare).
window.QuizPreviewSource = {
  notFoundText: 'Žaidimas nerastas šios naršyklės atmintyje',
  async loadGame() {
    const gameId = new URLSearchParams(window.location.search).get('id');
    return gameId ? QuizGameStorage.getGame(gameId) : null;
  },
  prepare: (game) => QuizMediaPreview.load(game),
  resolve: (value) => QuizMediaPreview.resolve(value),
};
