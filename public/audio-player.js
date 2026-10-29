// Our own controls for every <audio controls> on the page, in place of the
// browser's: laid out like Chrome's (▶, time, a bar, volume) but in the
// app's colours and themes, and the bar redrawn every frame while playing —
// the browser's moves only a few times a second. The <audio> itself stays
// (hidden, as it is without controls), so everything listening to it —
// play, pause, seeked, volumechange — carries on as before; these controls
// just drive it. Audio added later (the editor's question cards) gets them
// too, as soon as it's on the page.
(function (global) {
  const icon = (name) => global.QuizIcons.icon(name);

  const formatTime = (t) => {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const clamp = (v) => Math.min(1, Math.max(0, v));

  // A recording that didn't load — the connection dropped, or the request
  // never got an answer (nothing arriving for STALL_MS) — is asked for again
  // on its own, a few times (RETRY_DELAYS apart), while the element is on
  // the page. onFailed(true) as soon as a try fails — a player shows ↻ from
  // then on — and onFailed(false) once it's loaded after all. retry() (↻)
  // is one try more: made now if none is under way or waited for, otherwise
  // added to the ones left — never two at once.
  // Also for the view screen's and the preview's own <audio>, which have no
  // player of their own.
  // Short: served on the local network, a recording that's there comes at once.
  const RETRY_DELAYS = [1000, 1500, 2500];
  const STALL_MS = 3000;

  function keepLoading(audio, onFailed) {
    if (audio.quizKeepLoading) return audio.quizKeepLoading;
    let src = null;
    let tries = 0; // made again so far
    let allowed = RETRY_DELAYS.length; // ↻ adds one each
    // A try under way (watched for STALL_MS) or the next one waited for —
    // null once they've run out.
    let timer = null;
    let failed = false;
    const setFailed = (value) => {
      if (failed === value) return;
      failed = value;
      if (onFailed) onFailed(value);
    };
    const loaded = () => audio.readyState >= HTMLMediaElement.HAVE_METADATA;
    const stop = () => {
      clearTimeout(timer);
      timer = null;
    };
    const reset = () => {
      stop();
      tries = 0;
      allowed = RETRY_DELAYS.length;
      setFailed(false);
    };
    function tryNow() {
      stop();
      tries++;
      audio.load();
    }
    function again() {
      stop();
      if (!audio.getAttribute('src') || !audio.isConnected || loaded()) return;
      setFailed(true);
      if (tries >= allowed) return;
      timer = setTimeout(tryNow, RETRY_DELAYS[Math.min(tries, RETRY_DELAYS.length - 1)]);
    }
    // While nothing's arriving, it's waited on for so long only.
    const watch = () => {
      stop();
      if (!loaded()) timer = setTimeout(again, STALL_MS);
    };
    audio.addEventListener('loadstart', () => {
      // Another recording: tried afresh.
      if (audio.getAttribute('src') !== src) {
        src = audio.getAttribute('src');
        reset();
      }
      watch();
    });
    audio.addEventListener('progress', watch);
    audio.addEventListener('loadedmetadata', reset);
    audio.addEventListener('error', again);
    // Already on its way (the page's own, loading before this ran) — or failed.
    if (audio.getAttribute('src')) {
      src = audio.getAttribute('src');
      if (audio.error) again();
      else watch();
    }
    audio.quizKeepLoading = {
      retry() {
        allowed++;
        if (!timer) tryNow();
      },
    };
    return audio.quizKeepLoading;
  }

  function attach(audio) {
    if (audio.dataset.player) return;
    audio.dataset.player = 'custom';
    audio.removeAttribute('controls');

    const el = document.createElement('div');
    el.className = 'audio-player';
    el.innerHTML = `
      <button type="button" class="audio-player-btn audio-player-play"></button>
      <span class="audio-player-time"><span class="audio-player-current">0:00</span> / <span class="audio-player-duration">0:00</span></span>
      <div class="audio-player-track" role="slider" tabindex="0" aria-label="Vieta įraše" aria-valuemin="0">
        <div class="audio-player-clip" hidden></div>
        <div class="audio-player-fill"></div>
        <div class="audio-player-thumb"></div>
      </div>
      <div class="audio-player-volume">
        <input type="range" class="audio-player-volume-slider" min="0" max="1" step="0.05" aria-label="Garsumas">
        <button type="button" class="audio-player-btn audio-player-mute"></button>
      </div>
    `;
    audio.after(el);

    const playBtn = el.querySelector('.audio-player-play');
    const currentEl = el.querySelector('.audio-player-current');
    const durationEl = el.querySelector('.audio-player-duration');
    const track = el.querySelector('.audio-player-track');
    const clipEl = el.querySelector('.audio-player-clip');
    const muteBtn = el.querySelector('.audio-player-mute');
    const volumeSlider = el.querySelector('.audio-player-volume-slider');

    // Where the bar and time are drawn, 0–1 (while dragging, the pointer's).
    function showPosition(fraction) {
      const duration = audio.duration;
      track.style.setProperty('--progress', `${clamp(fraction) * 100}%`);
      currentEl.textContent = formatTime(clamp(fraction) * (isFinite(duration) ? duration : 0));
      durationEl.textContent = formatTime(duration);
      track.setAttribute('aria-valuemax', String(Math.floor(isFinite(duration) ? duration : 0)));
      track.setAttribute('aria-valuenow', String(Math.floor(audio.currentTime)));
    }

    let dragging = false;
    const render = () => {
      if (dragging) return;
      const duration = audio.duration;
      showPosition(isFinite(duration) && duration > 0 ? audio.currentTime / duration : 0);
    };

    // Every frame while it plays — the smooth sweep.
    let frame = null;
    const tick = () => {
      render();
      frame = audio.paused ? null : requestAnimationFrame(tick);
    };
    // A recording that wouldn't load even after the tries again (see
    // keepLoading): ▶ is ↻ then, to try once more.
    let failed = false;
    const loading = keepLoading(audio, (value) => {
      failed = value;
      syncPlaying();
    });
    const syncPlaying = () => {
      const playing = !audio.paused;
      playBtn.innerHTML = icon(failed ? 'refresh' : playing ? 'pause' : 'play');
      playBtn.title = failed ? 'Įrašo nepavyko įkelti – bandyti dar kartą' : playing ? 'Pauzė' : 'Groti';
      playBtn.setAttribute('aria-label', playBtn.title);
      if (playing && !frame) frame = requestAnimationFrame(tick);
      render();
    };
    ['play', 'pause', 'ended'].forEach((e) => audio.addEventListener(e, syncPlaying));
    ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange', 'emptied'].forEach((e) =>
      audio.addEventListener(e, render)
    );

    playBtn.addEventListener('click', () => {
      if (failed) loading.retry();
      else if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    });

    // The bar: clicked or dragged along to move through the track.
    const seekTo = (clientX) => {
      const rect = track.getBoundingClientRect();
      const fraction = clamp((clientX - rect.left) / rect.width);
      showPosition(fraction);
      if (isFinite(audio.duration)) audio.currentTime = fraction * audio.duration;
    };
    track.addEventListener('pointerdown', (e) => {
      if (!isFinite(audio.duration)) return;
      dragging = true;
      track.classList.add('is-dragging');
      track.setPointerCapture(e.pointerId);
      seekTo(e.clientX);
    });
    track.addEventListener('pointermove', (e) => {
      if (dragging) seekTo(e.clientX);
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      track.classList.remove('is-dragging');
      render();
    };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('keydown', (e) => {
      if (!isFinite(audio.duration)) return;
      const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[e.key];
      if (step) audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + step));
      else if (e.key === 'Home') audio.currentTime = 0;
      else if (e.key === 'End') audio.currentTime = audio.duration;
      else return;
      e.preventDefault();
    });

    // Volume, as in the browser's own: the speaker shows and switches whether
    // this copy is muted (the host's room page mutes it — the sound plays on
    // the view screen), the slider sets the volume (which the host's page
    // passes on to the view screen).
    let lastVolume = audio.volume || 1;
    const syncVolume = () => {
      const volume = audio.volume;
      if (volume > 0) lastVolume = volume;
      const silent = audio.muted || volume === 0;
      // Muted reads as 0, as in the browser's own.
      const shown = audio.muted ? 0 : volume;
      volumeSlider.value = String(shown);
      volumeSlider.style.setProperty('--volume', `${shown * 100}%`);
      muteBtn.innerHTML = icon(silent ? 'volume-off' : 'volume');
      muteBtn.title = silent ? 'Įjungti garsą' : 'Išjungti garsą';
      muteBtn.setAttribute('aria-label', muteBtn.title);
    };
    audio.addEventListener('volumechange', syncVolume);
    // Moved while muted: unmuted, at the new volume.
    volumeSlider.addEventListener('input', () => {
      audio.volume = Number(volumeSlider.value);
      if (audio.muted && audio.volume > 0) audio.muted = false;
    });
    muteBtn.addEventListener('click', () => {
      if (audio.muted || audio.volume === 0) {
        audio.muted = false;
        if (audio.volume === 0) audio.volume = lastVolume;
      } else {
        audio.muted = true;
      }
    });

    // The part of the track the question plays (data-start / data-end, in
    // seconds — empty: from the start / to the end), marked along the bar.
    // Only once there's a mark and the track's length is known; kept up as
    // the editor's fields change it.
    const syncClip = () => {
      const duration = audio.duration;
      const start = audio.dataset.start ? Number(audio.dataset.start) : null;
      const end = audio.dataset.end ? Number(audio.dataset.end) : null;
      const marked = (start != null && start > 0) || end != null;
      if (!marked || !isFinite(duration) || duration <= 0) {
        clipEl.hidden = true;
        return;
      }
      const from = clamp((start || 0) / duration);
      const to = clamp((end != null ? end : duration) / duration);
      clipEl.hidden = to <= from;
      clipEl.style.left = `${from * 100}%`;
      clipEl.style.width = `${(to - from) * 100}%`;
    };
    ['loadedmetadata', 'durationchange', 'emptied'].forEach((e) => audio.addEventListener(e, syncClip));
    new MutationObserver(syncClip).observe(audio, { attributes: true, attributeFilter: ['data-start', 'data-end'] });

    syncPlaying();
    syncVolume();
    syncClip();
  }

  function attachWithin(node) {
    if (!(node instanceof Element)) return;
    if (node.matches('audio[controls]')) attach(node);
    node.querySelectorAll('audio[controls]').forEach(attach);
  }

  function start() {
    attachWithin(document.body);
    new MutationObserver((mutations) => {
      mutations.forEach((m) => m.addedNodes.forEach(attachWithin));
    }).observe(document.body, { childList: true, subtree: true });
  }

  global.QuizAudioPlayer = { attach, keepLoading };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})(window);
