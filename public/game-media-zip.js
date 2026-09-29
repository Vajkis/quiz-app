// Games that carry their own picture/music files, packed as a .zip.
//
// The GitHub Pages editor can't learn a picked file's path (browsers never
// reveal it) and has no server to upload to, so it keeps picked files in the
// browser (see docs-src/js/media-store.js) and puts a reference in the field
// instead: "media:<id>/<file name>". Exporting such a game makes a .zip —
//   game.json (one game) or games.json (a list), plus
//   media/<id>/<file name> for every file the game(s) reference —
// and the main app's editor imports that .zip by uploading each file to the
// server and swapping the references for the addresses it gets back. The
// main app's editor exports the same way: its uploaded (/media/...) and
// local-path files are packed in as "media:..." references too (see
// public/game-export.js), so a .zip works in either editor.
//
// Shared by both editors (docs-src gets a copy at build time — see
// scripts/build-docs.js). Needs JSZip loaded first.
(function (global) {
  const MEDIA_REF_PREFIX = 'media:';

  const MIME_BY_EXT = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    // Also JPEG — Windows saves some downloads (e.g. from Gemini) as .jfif,
    // and the browser's file picker happily takes them.
    jfif: 'image/jpeg',
    jpe: 'image/jpeg',
    pjpeg: 'image/jpeg',
    pjp: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    webm: 'audio/webm',
  };

  function isMediaRef(value) {
    return typeof value === 'string' && value.startsWith(MEDIA_REF_PREFIX);
  }

  function mediaRef(id, fileName) {
    return `${MEDIA_REF_PREFIX}${id}/${fileName}`;
  }

  // "media:ab12cd/daina.mp3" -> "daina.mp3"
  function mediaRefFileName(ref) {
    return ref.slice(ref.indexOf('/') + 1);
  }

  function mimeForFileName(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
  }

  function refToZipPath(ref) {
    return 'media/' + ref.slice(MEDIA_REF_PREFIX.length);
  }

  function zipPathToRef(zipPath) {
    return MEDIA_REF_PREFIX + zipPath.slice('media/'.length);
  }

  // Every picture/music field of a game: question picture and music, and
  // each option's picture. fn(value) returns the new value for that field.
  function mapMediaFields(game, fn) {
    return {
      ...game,
      ...(game.background ? { background: fn(game.background) } : {}),
      stages: (game.stages || []).map((stage) => ({
        ...stage,
        questions: (stage.questions || []).map((q) => {
          const out = { ...q };
          if (q.img) out.img = fn(q.img);
          if (q.audio) out.audio = fn(q.audio);
          if (q.options) out.options = q.options.map((o) => (o && o.img ? { ...o, img: fn(o.img) } : o));
          return out;
        }),
      })),
    };
  }

  function collectMediaRefs(games) {
    const refs = new Set();
    games.forEach((game) =>
      mapMediaFields(game, (value) => {
        if (isMediaRef(value)) refs.add(value);
        return value;
      })
    );
    return refs;
  }

  // One game -> game.json, several -> games.json, plus every referenced
  // file (getBlob(ref) -> Blob, or null if it's gone — then it's skipped).
  async function buildZip(games, getBlob) {
    const zip = new global.JSZip();
    const single = games.length === 1;
    zip.file(single ? 'game.json' : 'games.json', JSON.stringify(single ? games[0] : games, null, 2));
    for (const ref of collectMediaRefs(games)) {
      const blob = await getBlob(ref);
      if (blob) zip.file(refToZipPath(ref), blob);
    }
    return zip.generateAsync({ type: 'blob' });
  }

  // -> { parsed: <the JSON inside>, files: Map(ref -> Blob) }. The JSON
  // still needs QuizGameShared.extractGamesFromImport, like a plain file.
  async function readZip(file) {
    const zip = await global.JSZip.loadAsync(file);
    const jsonEntry = zip.file('game.json') || zip.file('games.json');
    if (!jsonEntry) throw new Error('Zip faile nėra game.json');
    const parsed = JSON.parse(await jsonEntry.async('string'));
    const files = new Map();
    const entries = zip.file(/^media\/[^/]+\/[^/]+$/);
    for (const entry of entries) {
      const blob = await entry.async('blob');
      files.set(zipPathToRef(entry.name), new Blob([blob], { type: mimeForFileName(entry.name) }));
    }
    return { parsed, files };
  }

  function isZipFile(file) {
    return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
  }

  global.QuizGameMediaZip = {
    isMediaRef,
    mediaRef,
    mediaRefFileName,
    mimeForFileName,
    mapMediaFields,
    collectMediaRefs,
    buildZip,
    readZip,
    isZipFile,
  };
})(window);
