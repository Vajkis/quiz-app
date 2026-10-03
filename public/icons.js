// Every icon in the app as an inline SVG instead of a symbol or emoji
// character (×, ▶, ⭳, 🔒…), which some phones' and computers' fonts don't
// have. Line icons in the text's own colour, 1em big (see .icon in
// _base.scss), so they sit in a button or a line of text like a letter.
// Shared by the browser (QuizIcons.icon('close')), the server's EJS
// templates (icon('close'), see server.js) and the GitHub Pages build
// ({{icon:close}} in docs-src/*.html, see scripts/build-docs.js).
(function (root, factory) {
  const icons = factory();
  if (typeof module === 'object' && module.exports) module.exports = icons;
  else root.QuizIcons = icons;
})(this, function () {
  const filled = 'fill="currentColor" stroke="none"';
  const PATHS = {
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    play: `<path d="M7 4.6v14.8a1 1 0 0 0 1.5.9l11.8-7.4a1 1 0 0 0 0-1.8L8.5 3.7A1 1 0 0 0 7 4.6z" ${filled}/>`,
    pause: `<rect x="6" y="4" width="4" height="16" rx="1" ${filled}/><rect x="14" y="4" width="4" height="16" rx="1" ${filled}/>`,
    stop: `<rect x="5" y="5" width="14" height="14" rx="2" ${filled}/>`,
    edit: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/><path d="m15 5 4 4"/>',
    upload: '<path d="M12 21V8M7 13l5-5 5 5M5 3h14"/>',
    download: '<path d="M12 3v13M7 11l5 5 5-5M5 21h14"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    dot: `<circle cx="12" cy="12" r="3.5" ${filled}/>`,
    paper: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    'bell-off':
      '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20"/>',
    zoom: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    'arrow-left': '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    'arrow-right': '<path d="M5 12h14M12 5l7 7-7 7"/>',
    'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    'volume-off': '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    contrast: `<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" ${filled}/>`,
    droplet: '<path d="M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0z"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    games:
      '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    teams:
      '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
    screen: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    room: '<path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M2 21h20M16 7h3a1 1 0 0 1 1 1v13"/><path d="M12 12h.01"/>',
    rules: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  };

  function icon(name) {
    const paths = PATHS[name];
    if (!paths) throw new Error(`Unknown icon: ${name}`);
    return `<svg class="icon icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  }

  return { icon };
});
