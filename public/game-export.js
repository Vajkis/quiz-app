// Exporting games from the main app — the game editor's ⭳ and the games
// list's (one game, or all of them). Works like the GitHub Pages editor's
// export (docs-src/js/game-files.js): games with files of their own export
// as a .zip carrying them, ones without stay a plain .json. "Their own" =
// uploaded here (/media/...) or a local path on this computer — neither
// works anywhere else, so each is fetched and packed in, the field getting
// a "media:<id>/<name>" reference to it (the .zip format, see
// game-media-zip.js). http(s) links stay as they are.
// Needs JSZip, game-shared.js and game-media-zip.js loaded first.
(function (global) {
  function isOwnMedia(value) {
    return !!value && !/^https?:\/\//i.test(value) && !QuizGameMediaZip.isMediaRef(value);
  }

  function mediaFetchUrl(value) {
    return value.startsWith('/') ? value : `/api/local-audio?path=${encodeURIComponent(value)}`;
  }

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

    // field value -> "media:..." reference; the same file used in several
    // fields (or games) is packed once
    const refs = new Map();
    games.forEach((game) =>
      QuizGameMediaZip.mapMediaFields(game, (value) => {
        if (isOwnMedia(value) && !refs.has(value)) {
          // "C:\Muzika\daina.mp3" / "/media/<id>/<hash>.png" -> the file name
          const name = value.split(/[\\/]/).pop() || 'failas';
          refs.set(value, QuizGameMediaZip.mediaRef(QuizGameShared.generateId(null), name));
        }
        return value;
      })
    );

    if (!refs.size) {
      const data = games.length === 1 ? games[0] : games;
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${fileBase}.json`);
      return;
    }

    const blobs = new Map(); // "media:..." reference -> file contents
    for (const [value, ref] of refs) {
      const res = await fetch(mediaFetchUrl(value));
      if (!res.ok) throw new Error(`Nepavyko paimti failo: ${value}`);
      blobs.set(ref, await res.blob());
    }
    const packed = games.map((game) => QuizGameMediaZip.mapMediaFields(game, (value) => refs.get(value) || value));
    const zip = await QuizGameMediaZip.buildZip(packed, async (ref) => blobs.get(ref) || null);
    downloadBlob(zip, `${fileBase}.zip`);
  }

  global.QuizGameExport = { exportGames };
})(window);
