// The panel along the left edge of every host page (but login), the
// players' pages and the GitHub Pages editor's pages: where to go at the
// top, the look switches (and the host's "Atsijungti") at the bottom, and in
// between whatever the page adds (the game editor: its main buttons and its
// stages). A page asks for it with <body data-nav="host">, "player" or
// "docs".
// On a computer it's part of the page: collapsed it shows only icons,
// expanded icons with labels; which one is remembered in this browser. On a
// phone it's a menu instead, opened from a ☰ button in the bottom corner.
(function (global) {
  const OPEN_KEY = 'quiz-editor-side-panel-open';

  // Inline SVG icons (icons.js, loaded before this file).
  const icon = (name) => global.QuizIcons.icon(name);

  // Where each app's pages lead. `active` says whether it's the page open now:
  // the editor — a new game, a draft or a saved game — is "Naujas žaidimas".
  const path = window.location.pathname;
  const hostNewGame =
    path === '/host/games/new' || /^\/host\/(games|drafts)\/[^/]+\/edit$/.test(path);
  const docsNewGame = /editor\.html$/.test(path);
  const NAV = {
    host: [
      { icon: icon('home'), label: 'Skydelis', href: '/host', active: path === '/host' },
      {
        icon: icon('games'),
        label: 'Žaidimai',
        href: '/host/games',
        active: path.startsWith('/host/games') && !hostNewGame,
      },
      { icon: icon('plus'), label: 'Naujas žaidimas', href: '/host/games/new', active: hostNewGame },
      { icon: icon('teams'), label: 'Komandų istorija', href: '/host/teams', active: path === '/host/teams' },
      { icon: icon('screen'), label: 'Ekranas (naujame lange)', href: '/view', newTab: true },
    ],
    // Players: back to the join page and its room list.
    player: [{ icon: icon('home'), label: 'Kambariai', href: '/', active: path === '/' }],
    docs: [
      { icon: icon('games'), label: 'Žaidimai', href: 'index.html', active: !docsNewGame },
      { icon: icon('plus'), label: 'Naujas žaidimas', href: 'editor.html', active: docsNewGame },
    ],
  };

  let api = null;
  let leaveGuard = null;

  function mount() {
    if (api) return api;
    const nav = NAV[document.body.dataset.nav] || [];

    const panel = document.createElement('nav');
    panel.className = 'side-panel';
    panel.innerHTML = `
      <div class="side-panel-group side-panel-nav"></div>
      <div class="side-panel-group side-panel-bottom"></div>
    `;
    const navEl = panel.querySelector('.side-panel-nav');
    const bottomEl = panel.querySelector('.side-panel-bottom');

    // Same test as host.scss's side-panel-mobile: anything not desktop-wide.
    const mobileQuery = window.matchMedia('not all and (min-width: 768px)');

    // A button, or a link when `action` is { href, newTab }.
    function createItem(icon, label, action, className = '') {
      const link = typeof action === 'object';
      const el = document.createElement(link ? 'a' : 'button');
      if (link) {
        el.href = action.href;
        if (action.newTab) el.target = '_blank';
      } else {
        el.type = 'button';
      }
      el.className = `side-panel-item ${className}`.trim();
      el.title = label;
      el.innerHTML = '<span class="side-panel-icon"></span><span class="side-panel-label"></span>';
      setItem(el, icon, label);
      el.addEventListener('click', (e) => {
        // A page with unsaved work (the editor) asks first.
        if (link && !action.newTab && leaveGuard) {
          const message = leaveGuard();
          if (message && !confirm(message)) {
            e.preventDefault();
            return;
          }
        }
        // On a phone the menu covers the page — out of the way first.
        if (mobileQuery.matches) setMenuOpen(false);
        if (!link) action();
      });
      return el;
    }

    function setItem(el, icon, label) {
      const iconEl = el.querySelector('.side-panel-icon');
      if (icon.startsWith('<svg')) iconEl.innerHTML = icon;
      else iconEl.textContent = icon;
      el.querySelector('.side-panel-label').textContent = label;
      el.title = label;
    }

    // A group of items under a heading, above the bottom ones. The heading
    // is group.heading, for hiding it along with an empty group.
    function addSection(heading) {
      let headingEl = null;
      if (heading) {
        headingEl = document.createElement('p');
        headingEl.className = 'side-panel-heading';
        headingEl.textContent = heading;
        panel.insertBefore(headingEl, bottomEl);
      }
      const group = document.createElement('div');
      group.className = 'side-panel-group';
      group.heading = headingEl;
      panel.insertBefore(group, bottomEl);
      return group;
    }

    // Phones: a menu over the page, opened by a corner button and closed by
    // any item in it, the corner button again or a tap on the dimmed page.
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'side-panel-fab';
    const backdrop = document.createElement('div');
    backdrop.className = 'side-panel-backdrop';
    function setMenuOpen(open) {
      document.body.classList.toggle('side-panel-menu-open', open);
      fab.innerHTML = icon(open ? 'close' : 'menu');
      fab.title = open ? 'Uždaryti meniu' : 'Meniu';
    }
    fab.addEventListener('click', () =>
      setMenuOpen(!document.body.classList.contains('side-panel-menu-open'))
    );
    backdrop.addEventListener('click', () => setMenuOpen(false));
    setMenuOpen(false);

    const toggleBtn = createItem(
      icon('menu'),
      'Suskleisti',
      () => setOpen(!document.body.classList.contains('side-panel-open')),
      'side-panel-toggle'
    );
    function setOpen(open) {
      document.body.classList.toggle('side-panel-open', open);
      toggleBtn.title = open ? 'Suskleisti' : 'Išskleisti';
      try {
        localStorage.setItem(OPEN_KEY, open ? '1' : '');
      } catch (e) {}
    }

    navEl.appendChild(toggleBtn);
    nav.forEach((item) => {
      const el = createItem(item.icon, item.label, { href: item.href, newTab: item.newTab });
      if (item.active) el.classList.add('active');
      navEl.appendChild(el);
    });

    // The host's open rooms, like the dashboard lists them — kept current
    // (the same list the players' join page polls), hidden while there are
    // none.
    if (document.body.dataset.nav === 'host') {
      const roomsEl = addSection('Kambariai');
      let shownJson = null;
      const showRooms = (rooms) => {
        const json = JSON.stringify(rooms);
        if (json === shownJson) return;
        shownJson = json;
        roomsEl.innerHTML = '';
        rooms.forEach((room) => {
          const href = `/host/${room.id}`;
          const el = createItem(icon('room'), `${room.name} (${room.id})`, { href });
          if (path === href) el.classList.add('active');
          // The name gets cut short when it doesn't fit, never the code.
          const labelEl = el.querySelector('.side-panel-label');
          labelEl.classList.add('side-panel-room-label');
          labelEl.innerHTML =
            '<span class="side-panel-room-name"></span><span class="side-panel-room-id"></span>';
          labelEl.firstChild.textContent = room.name;
          labelEl.lastChild.textContent = `(${room.id})`;
          roomsEl.appendChild(el);
        });
        roomsEl.hidden = roomsEl.heading.hidden = !rooms.length;
      };
      showRooms([]);
      const loadRooms = () =>
        fetch('/api/rooms', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => data && showRooms(data.rooms || []))
          .catch(() => {});
      loadRooms();
      setInterval(() => {
        if (!document.hidden) loadRooms();
      }, 5000);
    }

    // The look switches (theme.js): the theme one shows what it switches
    // to; high contrast and no colour are on/off, lit up while on.
    if (global.QuizTheme) {
      const themeBtn = createItem('', '', () => QuizTheme.toggle('theme'));
      const contrastBtn = createItem(icon('contrast'), 'Didelis kontrastas', () =>
        QuizTheme.toggle('contrast')
      );
      const colorlessBtn = createItem(icon('droplet'), 'Be spalvų', () =>
        QuizTheme.toggle('colorless')
      );
      const showTheme = () => {
        if (QuizTheme.isDark()) setItem(themeBtn, icon('sun'), 'Šviesi tema');
        else setItem(themeBtn, icon('moon'), 'Tamsi tema');
        [
          [contrastBtn, 'contrast'],
          [colorlessBtn, 'colorless'],
        ].forEach(([btn, name]) => {
          btn.classList.toggle('active', QuizTheme.isOn(name));
          btn.setAttribute('aria-pressed', QuizTheme.isOn(name));
        });
      };
      showTheme();
      document.addEventListener('themechange', showTheme);
      bottomEl.append(themeBtn, contrastBtn, colorlessBtn);
    }

    if (document.body.dataset.nav === 'host') {
      bottomEl.appendChild(
        createItem(icon('logout'), 'Atsijungti', () => {
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = '/host/logout';
          document.body.appendChild(form);
          form.submit();
        })
      );
    }

    let open = false;
    try {
      open = localStorage.getItem(OPEN_KEY) === '1';
    } catch (e) {}
    setOpen(open);
    document.body.classList.add('has-side-panel');
    document.body.append(backdrop, panel, fab);

    api = {
      createItem,
      addSection,
      closeMenu: () => setMenuOpen(false),
      isMobile: () => mobileQuery.matches,
    };
    return api;
  }

  global.QuizSidePanel = {
    mount,
    // Asked before a link in the panel leaves the page: returns a message
    // to confirm, or nothing to just go.
    guardLeave(fn) {
      leaveGuard = fn;
    },
  };

  if (document.body && document.body.dataset.nav) mount();
  else
    document.addEventListener('DOMContentLoaded', () => {
      if (document.body.dataset.nav) mount();
    });
})(window);
