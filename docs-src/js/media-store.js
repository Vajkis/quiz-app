// Pictures and music picked with the 📁 buttons, kept in this browser's
// IndexedDB (room for far more than localStorage's few MB), keyed by the
// reference the game field holds — "media:<id>/<file name>" (see
// game-media-zip.js). Like the games themselves they stay on this
// browser/device; exporting a game as .zip is how they travel.
(function (global) {
  const DB_NAME = 'quizAppMedia';
  const STORE = 'files';

  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Nepavyko išsaugoti failo naršyklėje'));
    });
  }

  function getBlob(ref) {
    return run('readonly', (store) => store.get(ref)).then((blob) => blob || null);
  }

  function putBlob(ref, blob) {
    return run('readwrite', (store) => store.put(blob, ref));
  }

  // A freshly picked file: stored under a new reference, which is returned
  // (and is what goes into the field).
  async function addFile(file) {
    const id = QuizGameShared.generateId({});
    const name = file.name.replace(/[\\/]/g, '_');
    const ref = QuizGameMediaZip.mediaRef(id, name);
    await putBlob(ref, file);
    return ref;
  }

  // Drops stored files no game points at any more (after a delete, a save
  // that removed a picture, ...).
  async function removeUnused(games) {
    const used = QuizGameMediaZip.collectMediaRefs(games);
    const keys = await run('readonly', (store) => store.getAllKeys());
    const unused = (keys || []).filter((key) => !used.has(key));
    if (unused.length) await run('readwrite', (store) => unused.forEach((key) => store.delete(key)));
  }

  global.QuizMediaStore = { getBlob, putBlob, addFile, removeUnused };
})(window);
