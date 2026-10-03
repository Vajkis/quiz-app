// Where the host's preview (preview.js) gets its game: the saved game the
// server put into the page (#game-data), with pictures and music resolved
// the way the view screen does — uploaded files and URLs as they are, a
// local file path streamed through /api/local-audio.
window.QuizPreviewSource = {
  notFoundText: 'Žaidimas nerastas',
  async loadGame() {
    const dataEl = document.getElementById('game-data');
    return dataEl ? JSON.parse(dataEl.textContent) : null;
  },
  resolve(value) {
    if (!value) return '';
    if (/^https?:\/\//i.test(value) || value.startsWith('/')) return value;
    return `/api/local-audio?path=${encodeURIComponent(value)}`;
  },
};
