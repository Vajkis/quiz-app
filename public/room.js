const TEAM_KEY = 'quizTeam';

const joinForm = document.getElementById('join-form');
const teamInput = document.getElementById('team-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');

const teamInfo = document.getElementById('team-info');
const teamNameEl = document.getElementById('team-name');
const teamIdEl = document.getElementById('team-id');
const logoutBtn = document.getElementById('logout-btn');

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

function clearTeam() {
  localStorage.removeItem(TEAM_KEY);
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
  teamIdEl.textContent = team.id;
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
}

function logout() {
  clearTeam();
  teamInput.value = '';
  showJoinForm();
}

joinBtn.addEventListener('click', joinTeam);
teamInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinTeam();
});
logoutBtn.addEventListener('click', logout);

const storedTeam = getStoredTeam();
if (storedTeam) {
  showTeam(storedTeam);
} else {
  showJoinForm();
}
