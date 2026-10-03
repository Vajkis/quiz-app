// The panel along the left edge of every host page (but login), the
// players' pages and the GitHub Pages editor's pages: where to go at the
// top, the look switches (and "Atsijungti": the host's, or a player's team's)
// at the bottom, and in between whatever the page adds (the open rooms; the
// game editor: its main buttons and its
// stages). A page asks for it with <body data-nav="host">, "player" or
// "docs".
// On a computer it's part of the page: collapsed it shows only icons,
// expanded icons with labels; which one is remembered in this browser. On a
// phone it's a menu instead, opened from a ☰ button in the bottom corner.
(function (global) {
  const OPEN_KEY = 'quiz-editor-side-panel-open';
  // Where the players' pages keep their team (room.js, app.js).
  const PLAYER_TEAM_KEY = 'quizTeam';

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
      { icon: icon('screen'), label: 'Ekranas', note: '(naujame lange)', href: '/view', newTab: true },
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
      <div class="side-panel-footer">
        <div class="side-panel-group side-panel-bottom"></div>
      </div>
    `;
    const navEl = panel.querySelector('.side-panel-nav');
    const bottomEl = panel.querySelector('.side-panel-bottom');
    // Pushed to the panel's bottom: the line, then the host's season and the
    // look switches under it.
    const footerEl = panel.querySelector('.side-panel-footer');

    // Same test as host.scss's side-panel-mobile: anything not desktop-wide.
    const mobileQuery = window.matchMedia('not all and (min-width: 768px)');

    // A button, or a link when `action` is { href, newTab }. keepMenuOpen:
    // a button that changes something right here (the look switches, the
    // season), so the phone menu stays open — nothing to see behind it.
    function createItem(icon, label, action, className = '', { keepMenuOpen = false } = {}) {
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
        if (mobileQuery.matches && !keepMenuOpen) setMenuOpen(false);
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
        panel.insertBefore(headingEl, footerEl);
      }
      const group = document.createElement('div');
      group.className = 'side-panel-group';
      group.heading = headingEl;
      panel.insertBefore(group, footerEl);
      return group;
    }

    // Phones: a menu over the page, opened by a corner button and closed by
    // an item in it (but the ones that keep it open), the corner button again
    // or a tap on the dimmed page.
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'side-panel-fab';
    const backdrop = document.createElement('div');
    backdrop.className = 'side-panel-backdrop';
    function setMenuOpen(open) {
      document.body.classList.toggle('side-panel-menu-open', open);
      fab.innerHTML = icon(open ? 'close' : 'menu');
      fab.title = open ? 'Uždaryti meniu' : 'Meniu';
      // For what's in it to catch up (the open rooms).
      if (open) document.dispatchEvent(new Event('sidepanelopen'));
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
      // A note after the label, fainter — like a room's code in the rooms list.
      if (item.note) {
        const noteEl = document.createElement('span');
        noteEl.className = 'side-panel-note';
        noteEl.textContent = item.note;
        el.querySelector('.side-panel-label').append(' ', noteEl);
        el.title = item.label + ' ' + item.note;
      }
      navEl.appendChild(el);
    });

    // The open rooms under `heading`, as links to hrefPrefix + the room's id
    // — the same list the players' join page polls — hidden while there are
    // none. Returns the function that refreshes it.
    function mountRooms(heading, hrefPrefix) {
      const roomsEl = addSection(heading);
      let shownJson = null;
      const showRooms = (rooms) => {
        const json = JSON.stringify(rooms);
        if (json === shownJson) return;
        shownJson = json;
        roomsEl.innerHTML = '';
        rooms.forEach((room) => {
          const href = hrefPrefix + room.id;
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
      const load = () =>
        fetch('/api/rooms', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => data && showRooms(data.rooms || []))
          .catch(() => {});
      // Not left a poll behind: when the page comes back (a phone switched
      // back to it — no polling while hidden) and when the phone menu opens.
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) load();
      });
      document.addEventListener('sidepanelopen', load);
      return load;
    }

    // The players' team on this phone, as the join page keeps it (room.js).
    const playerTeam = () => {
      try {
        return JSON.parse(localStorage.getItem(PLAYER_TEAM_KEY));
      } catch (e) {
        return null;
      }
    };

    // A team's player: the open rooms to go to, once a team is set — the
    // join page sets it without a reload, and says so with teamchange.
    if (document.body.dataset.nav === 'player') {
      let roomsMounted = false;
      const showPlayerRooms = () => {
        if (roomsMounted || !playerTeam()) return;
        roomsMounted = true;
        // Not "Kambariai", the home link's name already.
        const loadRooms = mountRooms('Aktyvūs kambariai', '/');
        loadRooms();
        // As often as the join page's own list (room-list.js), so a new room
        // shows in both at once.
        setInterval(() => {
          if (!document.hidden) loadRooms();
        }, 3000);
      };
      showPlayerRooms();
      document.addEventListener('teamchange', showPlayerRooms);
    }

    // The host's open rooms, like the dashboard lists them, kept current.
    let seasonItem = null;
    if (document.body.dataset.nav === 'host') {
      // The active season, at the bottom under the look switches (put there
      // with "Atsijungti", below — kept apart from the editor's numbered
      // stages): its number in a circle (like the editor's stages, so it
      // reads with the panel collapsed too). Clicked, it switches to the
      // newest season in the teams' history, right here — no going to the
      // dashboard. Refreshed with the rooms below.
      seasonItem = createItem('–', 'Sezonas', () =>
        fetch('/api/host/season/latest', { method: 'POST' })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => data && showSeason(data.activeSeason))
          .catch(() => {}), 'side-panel-stage', { keepMenuOpen: true });
      let shownSeason;
      const showSeason = (season) => {
        if (season === shownSeason) return;
        shownSeason = season;
        setItem(seasonItem, season ? String(season) : '–', 'Sezonas');
        seasonItem.title = `${season ? `Sezonas ${season}` : 'Sezonas nenustatytas'} — paspaudus nustatomas naujausias istorijoje`;
        // For the page to follow (the dashboard's season field, host.js).
        document.dispatchEvent(new CustomEvent('seasonchange', { detail: season }));
      };
      const loadSeason = () =>
        fetch('/api/host/season', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => data && showSeason(data.activeSeason))
          .catch(() => {});

      const loadRooms = mountRooms('Kambariai', '/host/');
      loadSeason();
      loadRooms();
      setInterval(() => {
        if (document.hidden) return;
        loadSeason();
        loadRooms();
      }, 5000);
    }

    // The look switches (theme.js): the theme one shows what it switches
    // to; high contrast and no colour are on/off, lit up while on.
    if (global.QuizTheme) {
      const stay = { keepMenuOpen: true };
      const themeBtn = createItem('', '', () => QuizTheme.toggle('theme'), '', stay);
      const contrastBtn = createItem(
        icon('contrast'),
        'Didelis kontrastas',
        () => QuizTheme.toggle('contrast'),
        '',
        stay
      );
      const colorlessBtn = createItem(
        icon('droplet'),
        'Be spalvų',
        () => QuizTheme.toggle('colorless'),
        '',
        stay
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

    // A team's player: logs the team out on this phone, back to the join
    // page's form. Shown only while a team is set.
    if (document.body.dataset.nav === 'player') {
      const logoutItem = createItem(icon('logout'), 'Atsijungti', () => {
        try {
          localStorage.removeItem(PLAYER_TEAM_KEY);
        } catch (e) {}
        window.location.href = '/';
      });
      // Renaming the team: asked for here, saved by the server, then kept
      // on this phone and shown by the page (teamchange).
      const renameItem = createItem(
        icon('edit'),
        'Pervadinti komandą',
        async () => {
          const team = playerTeam();
          if (!team) return;
          const name = prompt('Naujas komandos pavadinimas', team.name);
          if (name === null || !name.trim() || name.trim() === team.name) return;
          try {
            const res = await fetch('/api/team/rename', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: team.id, name: name.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              alert(data.error || 'Nepavyko pakeisti pavadinimo');
              return;
            }
            localStorage.setItem(PLAYER_TEAM_KEY, JSON.stringify({ ...team, name: data.name }));
            document.dispatchEvent(new Event('teamchange'));
          } catch (e) {
            alert('Nepavyko pakeisti pavadinimo');
          }
        },
        '',
        { keepMenuOpen: true }
      );
      // The team's ID, which the page doesn't show: only told here (it's
      // what logs the team in on another phone), not a button.
      const idItem = document.createElement('div');
      idItem.className = 'side-panel-item side-panel-info';
      idItem.innerHTML = '<span class="side-panel-icon"></span><span class="side-panel-label"></span>';
      // A line between the look switches above and the team's own rows.
      const divider = document.createElement('div');
      divider.className = 'side-panel-divider';
      const showLogout = () => {
        const team = playerTeam();
        divider.hidden = idItem.hidden = renameItem.hidden = logoutItem.hidden = !team;
        if (team) setItem(idItem, icon('teams'), `ID: ${team.id}`);
      };
      showLogout();
      document.addEventListener('teamchange', showLogout);
      bottomEl.append(divider, idItem, renameItem, logoutItem);
    }

    // The host's own rows under the look switches, past a line like a
    // player's team rows: the season, then logging out.
    if (document.body.dataset.nav === 'host') {
      const divider = document.createElement('div');
      divider.className = 'side-panel-divider';
      bottomEl.append(
        divider,
        seasonItem,
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
