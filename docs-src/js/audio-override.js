// This static site has no server to stream a local file path through (the
// main app's game-editor-core.js falls back to /api/local-audio for those),
// so it only shows/plays http(s) URLs and files picked here with 📁 — those
// live in the browser (media-store.js), referenced as "media:...", and play
// from an object URL made for each one (see QuizMediaPreview).
// In the editor it must load after game-editor-core.js (which reads
// resolveAudioSrc fresh on every question card render, not just once at
// load) and before editor.js; the preview page (preview.js) has no editor
// core and uses QuizMediaPreview.resolve directly, for pictures too.
(function (global) {
  const objectUrls = new Map();

  function register(ref, blob) {
    if (!objectUrls.has(ref)) objectUrls.set(ref, URL.createObjectURL(blob));
  }

  // Makes object URLs for every picked file a game uses — run before its
  // cards are rendered, since resolve has to answer synchronously.
  async function load(game) {
    if (!game) return;
    for (const ref of QuizGameMediaZip.collectMediaRefs([game])) {
      if (objectUrls.has(ref)) continue;
      const blob = await QuizMediaStore.getBlob(ref);
      if (blob) register(ref, blob);
    }
  }

  function resolve(value) {
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return objectUrls.get(value) || '';
  }

  if (global.QuizGameEditorCore) global.QuizGameEditorCore.resolveAudioSrc = resolve;

  global.QuizMediaPreview = { register, load, resolve };
})(window);
