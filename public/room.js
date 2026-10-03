const TEAM_KEY = 'quizTeam';

const joinForm = document.getElementById('join-form');
const teamInput = document.getElementById('team-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');

const teamInfo = document.getElementById('team-info');
const teamNameEl = document.getElementById('team-name');

// The active rooms' links (join.ejs) — shown once a team is set.
const roomForm = document.getElementById('room-form');

function getStoredTeam() {
  try {
    return JSON.parse(localStorage.getItem(TEAM_KEY));
  } catch (err) {
    return null;
  }
}

function storeTeam(team) {
  localStorage.setItem(TEAM_KEY, JSON.stringify(team));
}

function showJoinForm() {
  joinForm.hidden = false;
  teamInfo.hidden = true;
  roomForm.hidden = true;
}

function showTeam(team) {
  joinForm.hidden = true;
  teamInfo.hidden = false;
  roomForm.hidden = false;
  teamNameEl.textContent = team.name;
}

async function joinTeam() {
  joinError.textContent = '';
  const value = teamInput.value.trim();
  if (!value) {
    joinError.textContent = 'Įvesk komandos pavadinimą arba ID';
    return;
  }

  const res = await fetch('/api/team/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: value }),
  });
  const data = await res.json();

  if (!res.ok) {
    joinError.textContent = data.error || 'Nepavyko prisijungti';
    return;
  }

  storeTeam(data);
  showTeam(data);
  // The side panel shows its rooms and "Atsijungti" from now on.
  document.dispatchEvent(new Event('teamchange'));
}

joinBtn.addEventListener('click', joinTeam);
teamInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinTeam();
});

const storedTeam = getStoredTeam();
if (storedTeam) {
  showTeam(storedTeam);
} else {
  showJoinForm();
}

// The server knows which team is logged in here, so the host adding it to a
// room (as if on paper) sends this phone straight in — as an ordinary team.
const socket = io();
const reportTeam = () => {
  const team = getStoredTeam();
  socket.emit('team-lobby', { teamId: team ? team.id : null });
};
socket.on('connect', reportTeam);
socket.on('go-to-room', ({ roomId }) => {
  window.location.href = `/${roomId}`;
});

// Logged in, or renamed from the side panel: its name, and the server told.
document.addEventListener('teamchange', () => {
  const team = getStoredTeam();
  if (team) showTeam(team);
  reportTeam();
});
