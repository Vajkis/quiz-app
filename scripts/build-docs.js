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

// {{icon:close}} in the pages becomes the same inline SVG the main app's
// templates get from icon('close') (public/icons.js).
const { icon } = require(path.join(publicDir, 'icons.js'));
for (const name of fs.readdirSync(docsOut)) {
  if (!name.endsWith('.html')) continue;
  const file = path.join(docsOut, name);
  const html = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, html.replace(/\{\{icon:([\w-]+)\}\}/g, (m, n) => icon(n)));
}

// The game preview page is the host's own template (its preview.js is
// copied below), rendered for this site's file layout.
const ejs = require('ejs');
const previewTemplate = path.join(root, 'views', 'host', 'game-preview.ejs');
fs.writeFileSync(
  path.join(docsOut, 'preview.html'),
  ejs.render(fs.readFileSync(previewTemplate, 'utf8'), { docs: true, icon }, { filename: previewTemplate })
);
console.log(`${path.relative(root, previewTemplate)} -> docs${path.sep}preview.html`);

console.log('Copying shared modules from public/...');
copyFile(path.join(publicDir, 'css', 'host.css'), path.join(docsOut, 'css', 'host.css'));
// The game preview page (preview.html) — the big screen's view.css plus its
// own navigation bar, compiled from styles/preview.scss.
copyFile(path.join(publicDir, 'css', 'preview.css'), path.join(docsOut, 'css', 'preview.css'));
copyFile(path.join(publicDir, 'game-shared.js'), path.join(docsOut, 'js', 'game-shared.js'));
copyFile(path.join(publicDir, 'game-editor-core.js'), path.join(docsOut, 'js', 'game-editor-core.js'));
copyFile(path.join(publicDir, 'game-media-zip.js'), path.join(docsOut, 'js', 'game-media-zip.js'));
copyFile(path.join(publicDir, 'icons.js'), path.join(docsOut, 'js', 'icons.js'));
copyFile(path.join(publicDir, 'audio-player.js'), path.join(docsOut, 'js', 'audio-player.js'));
// The tab icon, next to the pages (they link it relatively).
copyFile(path.join(publicDir, 'favicon.svg'), path.join(docsOut, 'favicon.svg'));
copyFile(path.join(publicDir, 'favicon.ico'), path.join(docsOut, 'favicon.ico'));
copyFile(path.join(publicDir, 'theme.js'), path.join(docsOut, 'js', 'theme.js'));
copyFile(path.join(publicDir, 'side-panel.js'), path.join(docsOut, 'js', 'side-panel.js'));
copyFile(path.join(publicDir, 'preview.js'), path.join(docsOut, 'js', 'preview.js'));
copyFile(
  path.join(root, 'node_modules', 'jszip', 'dist', 'jszip.min.js'),
  path.join(docsOut, 'js', 'vendor', 'jszip.min.js')
);
// host.css's @font-face rules reference ../fonts/ relative to css/, so
// fonts/ has to sit next to css/ here too, same as in public/.
copyDir(path.join(publicDir, 'fonts'), path.join(docsOut, 'fonts'));

console.log(`Done: ${path.relative(root, docsOut)}/`);
