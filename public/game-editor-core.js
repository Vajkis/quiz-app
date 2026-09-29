// Shared editor-form DOM logic: builds/reads the stage & question cards.
// Used by the server-backed editor (game-editor.js, wired to /api/games).
// A copy of this file lives at docs/js/game-editor-core.js for the static
// GitHub Pages editor (wired to localStorage instead) — they share the
// exact same markup/CSS, so the same builder works for both. Keep the two
// in sync by hand; the static copy only differs in defaultResolveAudioSrc,
// since it has no server to stream local file paths through.
(function (global) {
  // A question's audio field can be a full URL or (on the server-backed
  // editor only) a raw local file path streamed via /api/local-audio — the
  // static site has no server, so it only ever resolves http(s) URLs.
  // Override via QuizGameEditorCore.resolveAudioSrc = fn before use if a
  // page needs different behavior (see docs/js/editor.js).
  function defaultResolveAudioSrc(value) {
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) return value;
    return `/api/local-audio?path=${encodeURIComponent(value)}`;
  }

  function moveUp(el) {
    const prev = el.previousElementSibling;
    if (prev) el.parentElement.insertBefore(el, prev);
  }

  function moveDown(el) {
    const next = el.nextElementSibling;
    if (next) el.parentElement.insertBefore(next, el);
  }

  // Adds a "choose a file" button next to a picture/audio field (kind is
  // 'image' or 'audio'). Where the page can open the computer's own file
  // dialog (QuizGameEditorCore.pickLocalFile — the main app's editor, on the
  // server's computer), the field gets the file's real path. Otherwise the
  // browser's picker is used — it never reveals a path — and the file is
  // uploaded (QuizGameEditorCore.uploadFile), the field getting its address.
  // The static GitHub Pages editor has neither, so it gets no button.
  function attachFilePicker(input, kind) {
    const pickLocalFile = global.QuizGameEditorCore.pickLocalFile;
    const uploadFile = global.QuizGameEditorCore.uploadFile;
    if (typeof pickLocalFile !== 'function' && typeof uploadFile !== 'function')
      return;
    const accept = kind === 'audio' ? 'audio/*' : 'image/*';

    const field = document.createElement('div');
    field.className = 'file-url-field';
    input.parentNode.insertBefore(field, input);
    field.appendChild(input);

    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = accept;
    picker.className = 'file-input-hidden';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick-file-btn';
    btn.title = 'Pasirinkti failą iš kompiuterio';
    btn.setAttribute('aria-label', 'Pasirinkti failą iš kompiuterio');
    // Line icon (folder with an up arrow) in currentColor, matching the
    // editor's other icon buttons; swapped for a spinner while uploading.
    btn.innerHTML = `<svg class="pick-file-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
      <path d="M12 16.5v-5M9.5 14 12 11.5 14.5 14" />
    </svg><span class="pick-file-spinner" aria-hidden="true"></span>`;
    field.append(btn, picker);

    async function fill(getValue) {
      btn.disabled = true;
      btn.classList.add('is-uploading');
      try {
        const value = await getValue();
        if (!value) return; // dialog cancelled
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (err) {
        alert(err.message || 'Nepavyko pasirinkti failo');
      } finally {
        btn.disabled = false;
        btn.classList.remove('is-uploading');
      }
    }

    btn.addEventListener('click', () => {
      if (typeof pickLocalFile === 'function') fill(() => pickLocalFile(kind));
      else picker.click();
    });
    picker.addEventListener('change', () => {
      const file = picker.files[0];
      picker.value = '';
      if (file) fill(() => uploadFile(file));
    });
  }

  function createOptionRow(option) {
    const row = document.createElement('div');
    row.className = 'option-row';
    row.innerHTML = `
      <div class="option-row-main">
        <span class="correct-answer-badge" title="Teisingas atsakymas"><span class="check-icon"></span></span>
        <input type="text" class="option-text-input" placeholder="Atsakymo variantas">
        <span class="option-img-thumb-wrap" hidden><img class="option-img-thumb" alt="Nuotrauka"></span>
        <button type="button" class="remove-option-btn" title="Pašalinti variantą">×</button>
      </div>
      <input type="text" class="option-img-input" placeholder="Nuotraukos URL (nebūtina)">
    `;
    row.querySelector('.option-text-input').value =
      (option && option.text) || '';
    row.querySelector('.option-img-input').value = (option && option.img) || '';
    // Sent back on save so the server keeps it (see normalizeGamePayload);
    // the GitHub Pages editor strips ids before storing or exporting.
    if (option && option.id) row.dataset.optionId = option.id;
    attachFilePicker(row.querySelector('.option-img-input'), 'image');
    row
      .querySelector('.remove-option-btn')
      .addEventListener('click', () => row.remove());

    // A picture option is shown (on the view screen, in the answers) by its
    // letter, so it needs no text: once it has a picture, the text field
    // gives way to a thumbnail of it — much like the music field only shows
    // its clip controls once there's a track. Not on a typed-answer
    // question (a single option), whose text is the answer to type. Re-run
    // by the question card whenever its type changes (syncQuestionType).
    const textInput = row.querySelector('.option-text-input');
    const imgInput = row.querySelector('.option-img-input');
    const thumbWrap = row.querySelector('.option-img-thumb-wrap');
    const thumb = row.querySelector('.option-img-thumb');
    row.syncOptionImage = () => {
      const card = row.closest('.question-card');
      const isTextAnswer = !!card && card.classList.contains('text-answer');
      const src = imgInput.value.trim()
        ? global.QuizGameEditorCore.resolveAudioSrc(imgInput.value.trim())
        : '';
      const showThumb = !!src && !isTextAnswer;
      textInput.hidden = showThumb;
      thumbWrap.hidden = !showThumb;
      if (showThumb && thumb.getAttribute('src') !== src) thumb.src = src;
    };
    imgInput.addEventListener('change', row.syncOptionImage);
    return row;
  }

  function createQuestionCard(question) {
    const resolveAudioSrc = global.QuizGameEditorCore.resolveAudioSrc;
    const card = document.createElement('div');
    card.className = 'question-card';
    card.innerHTML = `
      <div class="question-header">
        <select class="question-type-select" title="Klausimo tipas">
          <option value="choice">Pasirenkami variantai</option>
          <option value="text">Įvedamas atsakymas</option>
          <option value="yesno">Taip arba Ne</option>
          <option value="chain">Grandinėlė</option>
        </select>
        <button type="button" class="move-question-up-btn move-btn" title="Kelti aukštyn"><span class="chevron-icon chevron-icon--up"></span></button>
        <button type="button" class="move-question-down-btn move-btn" title="Kelti žemyn"><span class="chevron-icon"></span></button>
        <button type="button" class="remove-question-btn" title="Pašalinti klausimą">×</button>
      </div>
      <input type="text" class="question-text-input" placeholder="Klausimo tekstas">
      <input type="text" class="question-img-input" placeholder="Klausimo nuotraukos URL (nebūtina)">
      <div class="question-img-thumb-wrap" hidden><img class="option-img-thumb" alt="Nuotrauka"></div>
      <input type="text" class="question-audio-input" placeholder="Klausimo muzikos/garso URL (nebūtina)">
      <div class="audio-clip-controls" hidden>
        <audio class="question-audio-preview" controls></audio>
        <div class="audio-clip-times">
          <div class="audio-clip-field-group">
            <input type="number" min="0" step="1" class="audio-start-input" placeholder="Nuo (s)">
            <button type="button" class="set-audio-start-btn">Nuo dabartinės</button>
          </div>
          <div class="audio-clip-field-group">
            <input type="number" min="0" step="1" class="audio-end-input" placeholder="Iki (s)">
            <button type="button" class="set-audio-end-btn">Iki dabartinės</button>
          </div>
          <button type="button" class="play-from-start-btn secondary-btn">▶ Groti pažymėtą dalį</button>
        </div>
      </div>
      <p class="correct-answer-hint"></p>
      <div class="options-section">
        <div class="options-container"></div>
        <button type="button" class="add-option-btn secondary-btn">+ Variantas</button>
      </div>
      <div class="yesno-section">
        <button type="button" class="yesno-btn" data-answer="yes">Taip</button>
        <button type="button" class="yesno-btn" data-answer="no">Ne</button>
      </div>
      <div class="chain-section">
        <div class="chain-links-container"></div>
        <button type="button" class="add-chain-link-btn secondary-btn">+ Užuomina</button>
      </div>
      <div class="bonus-section">
        <button type="button" class="add-bonus-btn secondary-btn">+ Papildomas klausimas</button>
        <div class="bonus-fields">
          <div class="bonus-header">
            <span class="bonus-title">Papildomas klausimas: +1 taškas, tik jei pagrindinis teisingas</span>
            <button type="button" class="remove-bonus-btn" title="Pašalinti papildomą atsakymą">×</button>
          </div>
          <input type="text" class="bonus-question-input" placeholder="Papildomas klausimas, pvz. Atlikėjas (nebūtina)">
          <input type="text" class="bonus-answer-input" placeholder="Teisingas papildomas atsakymas">
        </div>
      </div>
    `;
    card.querySelector('.question-text-input').value =
      (question && question.question) || '';
    if (question && question.id) card.dataset.questionId = question.id;
    const imgInput = card.querySelector('.question-img-input');
    imgInput.value = (question && question.img) || '';
    attachFilePicker(imgInput, 'image');

    // A small preview of the question's picture under its field, the same
    // thumbnail a picture option gets (see createOptionRow).
    const imgThumbWrap = card.querySelector('.question-img-thumb-wrap');
    const imgThumb = imgThumbWrap.querySelector('img');
    function syncQuestionImage() {
      const url = imgInput.value.trim();
      const src = url ? resolveAudioSrc(url) : '';
      imgThumbWrap.hidden = !src;
      if (src && imgThumb.getAttribute('src') !== src) imgThumb.src = src;
    }
    syncQuestionImage();
    imgInput.addEventListener('change', syncQuestionImage);
    card
      .querySelector('.remove-question-btn')
      .addEventListener('click', () => card.remove());
    card
      .querySelector('.move-question-up-btn')
      .addEventListener('click', () => moveUp(card));
    card
      .querySelector('.move-question-down-btn')
      .addEventListener('click', () => moveDown(card));

    const audioInput = card.querySelector('.question-audio-input');
    const audioClipControls = card.querySelector('.audio-clip-controls');
    const audioPreview = card.querySelector('.question-audio-preview');
    const audioStartInput = card.querySelector('.audio-start-input');
    const audioEndInput = card.querySelector('.audio-end-input');

    audioInput.value = (question && question.audio) || '';
    attachFilePicker(audioInput, 'audio');
    audioStartInput.value =
      question && question.audioStart != null ? question.audioStart : '';
    audioEndInput.value =
      question && question.audioEnd != null ? question.audioEnd : '';

    function syncAudioPreview() {
      const url = audioInput.value.trim();
      const src = url ? resolveAudioSrc(url) : '';
      audioClipControls.hidden = !src;
      if (src) audioPreview.src = src;
    }
    syncAudioPreview();
    audioInput.addEventListener('change', syncAudioPreview);

    // A question has a picture or music, not both: once one is filled in,
    // the other's field (with its 📁 button, if any) goes away until it's
    // cleared again. One that somehow has both keeps both, to clear one.
    const imgField = imgInput.closest('.file-url-field') || imgInput;
    const audioField = audioInput.closest('.file-url-field') || audioInput;
    function syncMediaFields() {
      const hasImg = !!imgInput.value.trim();
      const hasAudio = !!audioInput.value.trim();
      imgField.hidden = !hasImg && hasAudio;
      audioField.hidden = !hasAudio && hasImg;
    }
    syncMediaFields();
    [imgInput, audioInput].forEach((input) => {
      input.addEventListener('input', syncMediaFields);
      input.addEventListener('change', syncMediaFields);
    });

    card.querySelector('.set-audio-start-btn').addEventListener('click', () => {
      audioStartInput.value = Math.floor(audioPreview.currentTime);
    });
    card.querySelector('.set-audio-end-btn').addEventListener('click', () => {
      audioEndInput.value = Math.floor(audioPreview.currentTime);
    });

    // Preview the clip exactly as it'll play in-game: jump to "nuo" (empty =
    // 0, the very start) and auto-stop at "iki" (empty = let it run to the
    // recording's natural end). Mirrors host.js's clip-mode logic.
    let clipModeActive = false;
    let clipEndReached = false; // only auto-pause once per pass, so a manual
    // resume via the native controls afterwards isn't immediately re-paused

    audioPreview.addEventListener('timeupdate', () => {
      if (!clipModeActive) return;
      const end = audioEndInput.value.trim()
        ? Number(audioEndInput.value)
        : null;
      if (end == null) return;
      if (audioPreview.currentTime < end) {
        clipEndReached = false;
        return;
      }
      if (clipEndReached) return;
      clipEndReached = true;
      audioPreview.pause();
      audioPreview.currentTime = end;
    });

    card.querySelector('.play-from-start-btn').addEventListener('click', () => {
      clipModeActive = true;
      clipEndReached = false;
      audioPreview.currentTime = audioStartInput.value.trim()
        ? Number(audioStartInput.value)
        : 0;
      audioPreview.play();
    });

    const optionsContainer = card.querySelector('.options-container');
    let rawOptions =
      question && question.options && question.options.length
        ? question.options.slice()
        : [];
    if (question && question.answer) {
      const correctIdx = rawOptions.findIndex((o) => o.id === question.answer);
      if (correctIdx > 0) {
        const [correct] = rawOptions.splice(correctIdx, 1);
        rawOptions.unshift(correct);
      }
    }
    rawOptions.forEach((o) => {
      optionsContainer.appendChild(
        createOptionRow({ id: o.id, text: o.text, img: o.img })
      );
    });

    card.querySelector('.add-option-btn').addEventListener('click', () => {
      optionsContainer.appendChild(createOptionRow({}));
    });

    // Yes/no: the host picks the right one of the two fixed answers.
    const yesNoButtons = card.querySelectorAll('.yesno-btn');
    function setYesNo(answer) {
      if (answer) card.dataset.yesNo = answer;
      else delete card.dataset.yesNo;
      yesNoButtons.forEach((b) =>
        b.classList.toggle('active', b.dataset.answer === answer)
      );
    }
    setYesNo(question && question.type === 'yesno' ? question.answer : '');
    yesNoButtons.forEach((b) =>
      b.addEventListener('click', () => setYesNo(b.dataset.answer))
    );

    // Chain: clues, each with its own answer, kept in the order shown.
    const chainContainer = card.querySelector('.chain-links-container');
    ((question && question.links) || []).forEach((link) =>
      chainContainer.appendChild(createChainLinkRow(link))
    );
    card.querySelector('.add-chain-link-btn').addEventListener('click', () => {
      chainContainer.appendChild(createChainLinkRow({}));
    });

    // Extra answer: hidden behind its "+" button until added.
    const bonusFields = card.querySelector('.bonus-fields');
    const addBonusBtn = card.querySelector('.add-bonus-btn');
    const bonusQuestionInput = card.querySelector('.bonus-question-input');
    const bonusAnswerInput = card.querySelector('.bonus-answer-input');
    function showBonus(show) {
      bonusFields.hidden = !show;
      addBonusBtn.hidden = show;
    }
    if (question && question.bonus) {
      bonusQuestionInput.value = question.bonus.question || '';
      bonusAnswerInput.value = question.bonus.answer || '';
    }
    showBonus(!!(question && question.bonus));
    addBonusBtn.addEventListener('click', () => {
      showBonus(true);
      bonusQuestionInput.focus();
    });
    card.querySelector('.remove-bonus-btn').addEventListener('click', () => {
      bonusQuestionInput.value = '';
      bonusAnswerInput.value = '';
      showBonus(false);
    });

    // The type picks which answer fields show. Switching never throws
    // anything away — a typed-answer question just hides every option row
    // but the first, which is its answer — so switching back restores them.
    const typeSelect = card.querySelector('.question-type-select');
    const questionTextInput = card.querySelector('.question-text-input');
    const hint = card.querySelector('.correct-answer-hint');
    const HINTS = {
      choice: '✓ Pirmas variantas = teisingas atsakymas',
      text: '✎ Žaidėjai įves atsakymą patys — įrašyk teisingą atsakymą',
      yesno: '✓ Pažymėk teisingą atsakymą',
      chain:
        '✎ Kiekviena užuomina turi savo atsakymą, kuris nuo ankstesnio skiriasi viena raide — žaidėjai juos įrašys eilės tvarka. Taškas skiriamas, tik jei teisingi visi.'
    };
    typeSelect.value = global.QuizGameShared.questionType(question || {});
    function syncQuestionType() {
      const type = typeSelect.value;
      const minRows = { choice: 2, text: 1 }[type] || 0;
      while (optionsContainer.querySelectorAll('.option-row').length < minRows)
        optionsContainer.appendChild(createOptionRow({}));
      while (type === 'chain' && chainContainer.children.length < 2)
        chainContainer.appendChild(createChainLinkRow({}));

      card.classList.toggle('text-answer', type === 'text');
      card.querySelector('.options-section').hidden = !minRows;
      card.querySelector('.yesno-section').hidden = type !== 'yesno';
      card.querySelector('.chain-section').hidden = type !== 'chain';
      hint.textContent = HINTS[type];
      questionTextInput.placeholder =
        type === 'chain'
          ? 'Grandinėlės pavadinimas (nebūtina)'
          : 'Klausimo tekstas (nebūtina, jei yra nuotrauka ar garsas)';
      optionsContainer
        .querySelectorAll('.option-row')
        .forEach((row) => row.syncOptionImage());
    }
    syncQuestionType();
    typeSelect.addEventListener('change', syncQuestionType);
    new MutationObserver(syncQuestionType).observe(optionsContainer, {
      childList: true
    });

    return card;
  }

  function createChainLinkRow(link) {
    const row = document.createElement('div');
    row.className = 'chain-link-row';
    row.innerHTML = `
      <span class="chain-link-number"></span>
      <div class="chain-link-fields">
        <input type="text" class="chain-clue-input" placeholder="Užuomina">
        <input type="text" class="chain-answer-input" placeholder="Atsakymas">
      </div>
      <button type="button" class="remove-chain-link-btn" title="Pašalinti užuominą">×</button>
    `;
    row.querySelector('.chain-clue-input').value = (link && link.clue) || '';
    row.querySelector('.chain-answer-input').value =
      (link && link.answer) || '';
    row
      .querySelector('.remove-chain-link-btn')
      .addEventListener('click', () => row.remove());
    return row;
  }

  // A card's collapse chevron (.toggle-stage-btn): slides its body
  // (.stage-body) shut and open again. Used by the stages and the rules.
  function attachCollapse(toggleBtn, body, startCollapsed) {
    let collapsed = startCollapsed;
    toggleBtn.classList.toggle('collapsed', collapsed);
    if (collapsed) body.style.maxHeight = '0px';

    toggleBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      toggleBtn.classList.toggle('collapsed', collapsed);

      if (collapsed) {
        body.style.maxHeight = body.scrollHeight + 'px';
        requestAnimationFrame(() => {
          body.style.maxHeight = '0px';
        });
      } else {
        body.style.maxHeight = body.scrollHeight + 'px';
        body.addEventListener('transitionend', function onDone(e) {
          if (e.propertyName !== 'max-height') return;
          body.removeEventListener('transitionend', onDone);
          if (!collapsed) body.style.maxHeight = 'none'; // let it grow freely again
        });
      }
    });
  }

  function createStageCard(stage) {
    const card = document.createElement('div');
    card.className = 'stage-card';
    card.innerHTML = `
      <div class="stage-header">
        <button type="button" class="toggle-stage-btn" title="Suskleisti/išskleisti etapą"><span class="chevron-icon"></span></button>
        <input type="text" class="stage-name-input" placeholder="Etapo pavadinimas">
        <button type="button" class="move-stage-up-btn move-btn" title="Kelti aukštyn"><span class="chevron-icon chevron-icon--up"></span></button>
        <button type="button" class="move-stage-down-btn move-btn" title="Kelti žemyn"><span class="chevron-icon"></span></button>
        <button type="button" class="remove-stage-btn" title="Pašalinti etapą">×</button>
      </div>
      <div class="stage-body">
        <div class="questions-container"></div>
        <button type="button" class="add-question-btn secondary-btn">+ Klausimas</button>
      </div>
    `;
    card.querySelector('.stage-name-input').value = (stage && stage.name) || '';
    // Kept so the stage keeps its id (and its teams' history) across edits;
    // the GitHub Pages editor strips ids before storing or exporting.
    if (stage && stage.id) card.dataset.stageId = stage.id;
    card
      .querySelector('.remove-stage-btn')
      .addEventListener('click', () => card.remove());
    card
      .querySelector('.move-stage-up-btn')
      .addEventListener('click', () => moveUp(card));
    card
      .querySelector('.move-stage-down-btn')
      .addEventListener('click', () => moveDown(card));

    attachCollapse(
      card.querySelector('.toggle-stage-btn'),
      card.querySelector('.stage-body'),
      false
    );

    const questionsContainer = card.querySelector('.questions-container');
    const questions =
      stage && stage.questions && stage.questions.length
        ? stage.questions
        : [{}];
    questions.forEach((q) =>
      questionsContainer.appendChild(createQuestionCard(q))
    );

    card.querySelector('.add-question-btn').addEventListener('click', () => {
      questionsContainer.appendChild(createQuestionCard({}));
    });

    return card;
  }

  function createRuleRow(rule) {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.innerHTML = `
      <input type="text" class="rule-input" placeholder="Taisyklė">
      <button type="button" class="remove-rule-btn" title="Pašalinti taisyklę">×</button>
    `;
    row.querySelector('.rule-input').value = rule || '';
    row
      .querySelector('.remove-rule-btn')
      .addEventListener('click', () => row.remove());
    return row;
  }

  // The game's rules, above its first stage: a list, one rule per field
  // (shown on their own slide after the game's name), in a card that
  // collapses just like a stage's — and starts collapsed. Created here,
  // right before the stages, so both editors get it without markup of
  // their own.
  // The collapsible rules card itself, filled with `rules`; card.setRules()
  // refills it. Also used on its own by the games list, for the rules every
  // new game starts with (title: "Bendros taisyklės").
  function createRulesCard(rules, title = 'Taisyklės') {
    const card = document.createElement('div');
    card.className = 'stage-card rules-card';
    card.innerHTML = `
      <div class="stage-header rules-header">
        <button type="button" class="toggle-stage-btn" title="Suskleisti/išskleisti taisykles"><span class="chevron-icon"></span></button>
        <span class="rules-title"><span class="rules-title-text"></span> <span class="rules-count"></span></span>
      </div>
      <div class="stage-body">
        <div class="rules-body">
          <div class="rules-container"></div>
          <button type="button" class="add-rule-btn secondary-btn">+ Taisyklė</button>
        </div>
      </div>
    `;
    card.querySelector('.rules-title-text').textContent = title;
    attachCollapse(
      card.querySelector('.toggle-stage-btn'),
      card.querySelector('.stage-body'),
      true
    );
    const container = card.querySelector('.rules-container');
    card.querySelector('.add-rule-btn').addEventListener('click', () => {
      const row = createRuleRow('');
      container.appendChild(row);
      row.querySelector('.rule-input').focus();
    });
    // How many rules there are, so it shows even while collapsed.
    const count = card.querySelector('.rules-count');
    card.syncCount = () => {
      const n = collectRules(card).length;
      count.textContent = n ? `(${n})` : '';
    };
    card.addEventListener('input', card.syncCount);
    new MutationObserver(card.syncCount).observe(container, {
      childList: true
    });
    card.setRules = (list) => {
      container.innerHTML = '';
      (list && list.length ? list : ['']).forEach((rule) =>
        container.appendChild(createRuleRow(rule))
      );
      card.syncCount();
    };
    card.setRules(rules);
    return card;
  }

  // "Bendros taisyklės" on the games list: a rules card put first in `el`,
  // saved as it's edited — save(rules) is the page's own (the server, or
  // this browser's storage) and may return a promise; statusEl says how
  // it went.
  function mountDefaultRules(el, rules, save, statusEl) {
    const card = createRulesCard(rules, 'Bendros taisyklės');
    el.insertBefore(card, el.firstChild);
    let last = JSON.stringify(collectRules(card));
    let timer = null;
    async function flush() {
      clearTimeout(timer);
      timer = null;
      const list = collectRules(card);
      const json = JSON.stringify(list);
      if (json === last) return;
      last = json;
      try {
        await save(list);
        if (statusEl) statusEl.textContent = 'Taisyklės išsaugotos';
      } catch (err) {
        last = null; // try again on the next change
        if (statusEl) statusEl.textContent = (err && err.message) || 'Nepavyko išsaugoti taisyklių';
      }
    }
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(flush, 600);
    };
    card.addEventListener('input', schedule);
    new MutationObserver(schedule).observe(card.querySelector('.rules-container'), {
      childList: true
    });
    // Leaving before the delay's up still saves what was typed last.
    global.addEventListener('pagehide', () => {
      if (timer) flush();
    });
    return card;
  }

  // A saved game or a draft being edited doesn't get the shared rules on
  // its own (only a brand-new game does) — this button, next to
  // "+ Taisyklė", puts them in instead of the game's current ones.
  function addDefaultRulesButton(stagesContainer, defaultRules) {
    if (!defaultRules || !defaultRules.length) return;
    const card = stagesContainer.parentNode.querySelector('.rules-card');
    if (!card || card.querySelector('.use-default-rules-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'use-default-rules-btn secondary-btn';
    btn.textContent = 'Naudoti bendras taisykles';
    btn.addEventListener('click', () => {
      const current = collectRules(card);
      if (JSON.stringify(current) === JSON.stringify(defaultRules)) return;
      if (current.length && !confirm('Pakeisti šio žaidimo taisykles bendrosiomis?')) return;
      card.setRules(defaultRules);
    });
    card.querySelector('.add-rule-btn').after(btn);
  }

  function renderRules(stagesContainer, rules) {
    const card = stagesContainer.parentNode.querySelector('.rules-card');
    if (card) card.setRules(rules);
    else stagesContainer.parentNode.insertBefore(createRulesCard(rules), stagesContainer);
  }

  function collectRules(card) {
    return Array.from(card.querySelectorAll('.rule-input'))
      .map((input) => input.value.trim())
      .filter(Boolean);
  }

  function renderGame(stagesContainer, nameInput, game) {
    nameInput.value = (game && game.name) || '';
    renderRules(stagesContainer, game && game.rules);
    stagesContainer.innerHTML = '';
    const stages =
      game && game.stages && game.stages.length ? game.stages : [{}];
    stages.forEach((s) => stagesContainer.appendChild(createStageCard(s)));
  }

  function collectPayload(stagesContainer, nameInput) {
    const rulesCard = stagesContainer.parentNode.querySelector('.rules-card');
    const rules = rulesCard ? collectRules(rulesCard) : [];
    const stages = Array.from(
      stagesContainer.querySelectorAll('.stage-card')
    ).map((stageEl) => {
      const questions = Array.from(
        stageEl.querySelectorAll('.question-card')
      ).map((qEl) => {
        const type = qEl.querySelector('.question-type-select').value;
        const out = {
          id: qEl.dataset.questionId || undefined,
          type,
          question: qEl.querySelector('.question-text-input').value.trim(),
          img: qEl.querySelector('.question-img-input').value.trim(),
          audio: qEl.querySelector('.question-audio-input').value.trim(),
          audioStart: qEl.querySelector('.audio-start-input').value.trim(),
          audioEnd: qEl.querySelector('.audio-end-input').value.trim()
        };
        if (type === 'choice' || type === 'text') {
          // First option row is always the correct answer (see
          // createOptionRow); a typed-answer question only has that one.
          const options = Array.from(qEl.querySelectorAll('.option-row')).map(
            (oEl) => ({
              id: oEl.dataset.optionId || undefined,
              text: oEl.querySelector('.option-text-input').value.trim(),
              img: oEl.querySelector('.option-img-input').value.trim()
            })
          );
          out.options = type === 'text' ? options.slice(0, 1) : options;
        } else if (type === 'yesno') {
          out.answer = qEl.dataset.yesNo || '';
        } else {
          out.links = Array.from(qEl.querySelectorAll('.chain-link-row')).map(
            (row) => ({
              clue: row.querySelector('.chain-clue-input').value.trim(),
              answer: row.querySelector('.chain-answer-input').value.trim()
            })
          );
        }
        if (!qEl.querySelector('.bonus-fields').hidden) {
          out.bonus = {
            question: qEl.querySelector('.bonus-question-input').value.trim(),
            answer: qEl.querySelector('.bonus-answer-input').value.trim()
          };
        }
        return out;
      });
      return {
        id: stageEl.dataset.stageId || undefined,
        name: stageEl.querySelector('.stage-name-input').value.trim(),
        questions
      };
    });

    return { name: nameInput.value.trim(), rules, stages };
  }

  // An imported file with several games in it (e.g. an "Eksportuoti visus"
  // file): lists them under the editor's buttons, same rows as the games
  // list, and resolves with the one picked — or null on "Atšaukti". A row
  // only selects; nothing is imported until "Patvirtinti", so a mis-tap
  // can't replace the form with the wrong game.
  function chooseImportGame(games, afterEl) {
    const old = document.querySelector('.import-choice');
    if (old) old.cancel();

    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'import-choice';

      const label = document.createElement('p');
      label.className = 'section-label';
      label.textContent = `Faile rasti ${games.length} žaidimai – pasirink, kurį importuoti:`;
      box.appendChild(label);

      function finish(game) {
        box.remove();
        resolve(game);
      }
      box.cancel = () => finish(null);

      let selected = null;
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'import-choice-confirm';
      confirmBtn.textContent = 'Patvirtinti';
      confirmBtn.disabled = true;
      confirmBtn.addEventListener('click', () => {
        if (selected) finish(selected);
      });

      games.forEach((game) => {
        const stages = game.stages || [];
        const questionCount = stages.reduce(
          (n, s) => n + ((s && s.questions) || []).length,
          0
        );
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'option';
        btn.textContent = `${game.name || 'Be pavadinimo'} (${stages.length} etapai, ${questionCount} klausimai)`;
        btn.addEventListener('click', () => {
          box
            .querySelectorAll('.option.selected')
            .forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          selected = game;
          confirmBtn.disabled = false;
        });
        box.appendChild(btn);
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'secondary-btn';
      cancelBtn.textContent = 'Atšaukti';
      cancelBtn.addEventListener('click', () => finish(null));

      const actions = document.createElement('div');
      actions.className = 'import-choice-actions';
      actions.append(cancelBtn, confirmBtn);
      box.appendChild(actions);

      afterEl.after(box);
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  global.QuizGameEditorCore = {
    resolveAudioSrc: defaultResolveAudioSrc,
    // Set by a page that can pick/upload files (see attachFilePicker).
    pickLocalFile: null,
    uploadFile: null,
    moveUp,
    moveDown,
    createOptionRow,
    createQuestionCard,
    createStageCard,
    renderGame,
    collectPayload,
    createRulesCard,
    collectRules,
    mountDefaultRules,
    addDefaultRulesButton,
    chooseImportGame
  };
})(window);
