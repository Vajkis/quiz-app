// Assembles docs/ (gitignored build output, published to GitHub Pages) from
// docs-src/ (hand-written, tracked in git) plus the modules it shares with
// the main app's editor — public/game-shared.js, public/game-editor-core.js,
// public/game-media-zip.js (plus the JSZip library it needs, from
// node_modules) and the compiled public/css/host.css and preview.css (run `npm run
// build:css` first, or use the "build:docs" script which does that for you).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const docsSrc = path.join(root, 'docs-src');
const docsOut = path.join(root, 'docs');
const publicDir = path.join(root, 'public');

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`${path.relative(root, from)} -> ${path.relative(root, to)}`);
}

function copyDir(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const fromPath = path.join(from, entry.name);
    const toPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(fromPath, toPath);
    else copyFile(fromPath, toPath);
  }
}

fs.rmSync(docsOut, { recursive: true, force: true });

console.log('Copying docs-src/ (site-specific pages)...');
copyDir(docsSrc, docsOut);

console.log('Copying shared modules from public/...');
copyFile(path.join(publicDir, 'css', 'host.css'), path.join(docsOut, 'css', 'host.css'));
// The game preview page (preview.html) — the big screen's view.css plus its
// own navigation bar, compiled from styles/preview.scss.
copyFile(path.join(publicDir, 'css', 'preview.css'), path.join(docsOut, 'css', 'preview.css'));
copyFile(path.join(publicDir, 'game-shared.js'), path.join(docsOut, 'js', 'game-shared.js'));
copyFile(path.join(publicDir, 'game-editor-core.js'), path.join(docsOut, 'js', 'game-editor-core.js'));
copyFile(path.join(publicDir, 'game-media-zip.js'), path.join(docsOut, 'js', 'game-media-zip.js'));
copyFile(
  path.join(root, 'node_modules', 'jszip', 'dist', 'jszip.min.js'),
  path.join(docsOut, 'js', 'vendor', 'jszip.min.js')
);
// host.css's @font-face rules reference ../fonts/ relative to css/, so
// fonts/ has to sit next to css/ here too, same as in public/.
copyDir(path.join(publicDir, 'fonts'), path.join(docsOut, 'fonts'));

console.log(`Done: ${path.relative(root, docsOut)}/`);
