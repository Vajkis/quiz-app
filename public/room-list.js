// Keeps the "Aktyvūs kambariai" list (player/join.ejs, view/dashboard.ejs)
// current: the host opens and closes rooms while these pages sit open, and
// nobody should have to reload to see a new one. The list's links go to
// data-href-prefix + the room id ("/" for players, "/view/" for screens).
(function () {
  const listEl = document.getElementById('room-list');
  if (!listEl) return;
  const hrefPrefix = listEl.dataset.hrefPrefix || '/';
  let shown = null;

  function render(rooms) {
    listEl.innerHTML = '';
    if (rooms.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Nėra aktyvių kambarių.';
      listEl.appendChild(empty);
      return;
    }
    const label = document.createElement('p');
    label.className = 'section-label';
    label.textContent = 'Aktyvūs kambariai:';
    listEl.appendChild(label);
    rooms.forEach((room) => {
      const link = document.createElement('a');
      link.className = 'option';
      link.href = hrefPrefix + room.id;
      link.textContent = `${room.name} (${room.id})`;
      listEl.appendChild(link);
    });
  }

  function check() {
    fetch('/api/rooms', { cache: 'no-store' })
      .then((res) => res.json())
      .then(({ rooms }) => {
        const key = JSON.stringify(rooms);
        if (key === shown) return;
        shown = key;
        render(rooms);
      })
      .catch(() => {});
  }

  check();
  setInterval(check, 3000);
})();
