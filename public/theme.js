// The look switches, loaded in <head> (before the page paints, so it never
// flashes the wrong one) on every page but the big screen's: dark theme,
// high contrast and no colour, each an attribute on <html> — the colours
// themselves are in styles/_theme.scss. Switched from the side panel
// (side-panel.js) or, where there's none, the corner .theme-toggle-btn
// buttons (data-toggle="theme" / "contrast" / "colorless"). Each choice is
// kept per browser, so it carries over to every page and tab.
(function (global) {
  const root = document.documentElement;

  // name: [localStorage key, the <html> attribute, its value when on]
  const SWITCHES = {
    theme: ['quizAppTheme', 'data-theme', 'dark'],
    contrast: ['quizAppContrast', 'data-contrast', 'high'],
    colorless: ['quizAppColorless', 'data-colorless', ''],
  };

  // The corner buttons: icon and title for off / on.
  const BUTTONS = {
    theme: [['moon', 'Tamsi tema'], ['sun', 'Šviesi tema']],
    contrast: [['contrast', 'Didelis kontrastas'], ['contrast', 'Įprastas kontrastas']],
    colorless: [['droplet', 'Be spalvų'], ['droplet', 'Su spalvomis']],
  };

  function isOn(name) {
    return root.hasAttribute(SWITCHES[name][1]);
  }

  function showButtons() {
    document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
      const name = btn.dataset.toggle || 'theme';
      const on = isOn(name);
      const [icon, title] = BUTTONS[name][on ? 1 : 0];
      btn.innerHTML = global.QuizIcons.icon(icon);
      btn.title = title;
      btn.setAttribute('aria-label', title);
      // The theme button shows what it switches to; the others are on/off.
      if (name !== 'theme') {
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on);
      }
    });
  }

  function apply(name, on) {
    const [, attr, value] = SWITCHES[name];
    if (on) root.setAttribute(attr, value);
    else root.removeAttribute(attr);
    showButtons();
    document.dispatchEvent(new Event('themechange'));
  }

  function toggle(name = 'theme') {
    const on = !isOn(name);
    apply(name, on);
    try {
      localStorage.setItem(SWITCHES[name][0], on ? '1' : '');
    } catch (e) {}
  }

  // Saved before as 'dark' / 'light' (the theme), now '1' / '' for all.
  const savedOn = (value) => value === '1' || value === 'dark';
  Object.keys(SWITCHES).forEach((name) => {
    let saved = null;
    try {
      saved = localStorage.getItem(SWITCHES[name][0]);
    } catch (e) {}
    apply(name, savedOn(saved));
  });

  document.addEventListener('DOMContentLoaded', () => {
    showButtons();
    document
      .querySelectorAll('.theme-toggle-btn')
      .forEach((btn) => btn.addEventListener('click', () => toggle(btn.dataset.toggle || 'theme')));
  });

  // Switched in another tab (e.g. the dashboard while a room is open).
  window.addEventListener('storage', (e) => {
    const name = Object.keys(SWITCHES).find((n) => SWITCHES[n][0] === e.key);
    if (name) apply(name, savedOn(e.newValue));
  });

  global.QuizTheme = {
    isDark: () => isOn('theme'),
    isOn,
    toggle,
  };
})(window);
