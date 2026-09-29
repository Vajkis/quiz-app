// Dev-only static server for docs/ (the GitHub Pages build output) with
// browser auto-reload. Pairs with "build:docs:watch" (nodemon rebuilding
// docs/ from docs-src/ + public/ on source changes) — this server just
// watches the docs/ output itself and pushes a reload over SSE whenever it
// changes, so the two can run independently via "dev:docs".
//
// The reload script is injected into HTML responses on the fly, never
// written to disk — docs-src/ and the published docs/ stay exactly what
// gets deployed, with no dev-only code leaking in.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const docsDir = path.join(root, 'docs');
const port = Number(process.env.PORT) || 3001;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const LIVERELOAD_SCRIPT = `
<script>
(function () {
  var es = new EventSource('/__livereload');
  es.onmessage = function () { location.reload(); };
})();
</script>
</body>`;

let sseClients = [];

function broadcastReload() {
  for (const res of sseClients) res.write('data: reload\n\n');
}

// docs/ gets rewritten wholesale on every rebuild (old files removed, all
// files re-copied) — that's a burst of several fs events for one logical
// change, so debounce down to a single reload instead of reloading once per
// file.
let debounceTimer = null;
function scheduleReload() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(broadcastReload, 150);
}

// build-docs.js rm -rf's docs/ and recreates it on every rebuild, which
// invalidates a recursive Windows watch mid-flight (EPERM) — that error
// would otherwise be unhandled and crash this process, so catch it and
// just re-establish the watch shortly after (by then the rebuild's done).
function watchDocs() {
  let watcher;
  try {
    watcher = fs.watch(docsDir, { recursive: true }, () => scheduleReload());
  } catch {
    setTimeout(watchDocs, 500);
    return;
  }
  watcher.on('error', () => {
    watcher.close();
    setTimeout(watchDocs, 500);
  });
}
watchDocs();

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/__livereload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter((c) => c !== res);
    });
    return;
  }

  let filePath = path.join(docsDir, url === '/' ? 'index.html' : url);
  if (!filePath.startsWith(docsDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + url);
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });

    if (ext === '.html') {
      res.end(data.toString('utf8').replace('</body>', LIVERELOAD_SCRIPT));
    } else {
      res.end(data);
    }
  });
});

// Bind to 0.0.0.0 (all interfaces), not just loopback — same as server.js —
// so this is also reachable from phones etc. on the LAN via this machine's
// LAN_IP, not just from localhost on this machine.
server.listen(port, '0.0.0.0', () => {
  console.log(`docs/ served at http://localhost:${port} (auto-reloads on rebuild)`);
});
