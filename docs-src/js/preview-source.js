// Where the GitHub Pages preview (preview.js) gets its game: this browser's
// storage, by the ?id= in the address, with the files picked here with 📁
// (IndexedDB, see media-store.js) turned into playable object URLs.
window.QuizPreviewSource = {
  notFoundText: 'Žaidimas nerastas šios naršyklės atmintyje',
  async loadGame() {
    const gameId = new URLSearchParams(window.location.search).get('id');
    const game = gameId ? QuizGameStorage.getGame(gameId) : null;
    if (game) await QuizMediaPreview.load(game).catch(() => {});
    return game;
  },
  resolve: (value) => QuizMediaPreview.resolve(value),
};
