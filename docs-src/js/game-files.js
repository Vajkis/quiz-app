// Reading and writing game files for this site's editor and games list. A
// game with pictures/music picked here (📁, kept in the browser — see
// media-store.js) exports as a .zip carrying those files; one without any
// stays a plain .json. Imports take either.
(function (global) {
  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeFileName(name) {
    const safe = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return safe || 'zaidimas';
  }

  // games: portable (id-less) games. One game -> <its name>.json/.zip,
  // several -> <baseName>.json/.zip.
  async function exportGames(games, baseName) {
    const fileBase = games.length === 1 ? safeFileName(games[0].name) : baseName;
    if (QuizGameMediaZip.collectMediaRefs(games).size) {
      const zip = await QuizGameMediaZip.buildZip(games, QuizMediaStore.getBlob);
      downloadBlob(zip, `${fileBase}.zip`);
      return;
    }
    const data = games.length === 1 ? games[0] : games;
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${fileBase}.json`);
  }

  // -> { games } or { error }. A .zip's files go into this browser's media
  // store first, so the games' references to them work right away.
  async function importFile(file) {
    let parsed;
    try {
      if (QuizGameMediaZip.isZipFile(file)) {
        const zip = await QuizGameMediaZip.readZip(file);
        for (const [ref, blob] of zip.files) await QuizMediaStore.putBlob(ref, blob);
        parsed = zip.parsed;
      } else {
        parsed = JSON.parse(await file.text());
      }
    } catch (err) {
      return { error: err.message && QuizGameMediaZip.isZipFile(file) ? err.message : 'Netinkamas failas' };
    }
    return QuizGameShared.extractGamesFromImport(parsed);
  }

  global.QuizGameFiles = { exportGames, importFile };
})(window);
