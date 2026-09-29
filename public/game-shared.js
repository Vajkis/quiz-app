// Shared by the main app's game editor and the static GitHub Pages editor
// (docs-src/, which gets a copy of this file at build time — see
// scripts/build-docs.js): validating a game and reading/writing it as a
// portable, id-less JSON file. Ids are the server's business alone.
(function (global) {
  const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // be dviprasmiškų simbolių: i, l, o, 0, 1

  // Only for the GitHub Pages editor's own localStorage keys — never part
  // of a game or an exported file.
  function generateId(existingMap) {
    let id;
    do {
      id = '';
      for (let i = 0; i < 6; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    } while (existingMap && existingMap[id]);
    return id;
  }

  // Validates and tidies an editor form submission into the portable game
  // format: { name, stages: [{ name, questions: [{ question, img?, audio?,
  // audioStart?, audioEnd?, options: [{ text, img? }] }] }] }, the first
  // option being the correct one (the editor's own convention — see
  // createOptionRow in game-editor-core.js). It carries no ids at all: this
  // runs in the GitHub Pages editor and for exports, and ids are only ever
  // created by the server when a game is saved or imported there (see
  // normalizeGamePayload in server.js), so files from different places
  // can never bring clashing ids along.
  function normalizeGamePayload(body) {
    const name = ((body && body.name) || '').trim();
    if (!name) return { error: 'Įvesk žaidimo pavadinimą' };
    if (!body || !Array.isArray(body.stages) || body.stages.length === 0) {
      return { error: 'Pridėk bent vieną etapą' };
    }

    const stages = [];
    for (const stage of body.stages) {
      const stageName = ((stage && stage.name) || '').trim();
      if (!stageName) return { error: 'Kiekvienas etapas turi turėti pavadinimą' };
      if (!stage || !Array.isArray(stage.questions) || stage.questions.length === 0) {
        return { error: `Etapas "${stageName}" turi turėti bent vieną klausimą` };
      }

      const questions = [];
      for (const q of stage.questions) {
        const questionText = ((q && q.question) || '').trim();
        if (!questionText) return { error: 'Kiekvienas klausimas turi turėti tekstą' };
        if (!q || !Array.isArray(q.options) || q.options.length < 1) {
          return { error: `Klausimas "${questionText}" turi turėti bent 1 atsakymo variantą (vienas = atsakymas įvedamas)` };
        }

        const options = q.options.map((o) => {
          const option = { text: ((o && o.text) || '').trim() };
          const img = ((o && o.img) || '').trim();
          if (img) option.img = img;
          return option;
        });
        // A picture option has no text at all (it's shown by its letter;
        // any text would give the answer away, even as an alt); a
        // typed-answer question's single option is the answer, so it does.
        if (options.length > 1) {
          options.forEach((o) => {
            if (o.img) o.text = '';
          });
        }
        if (options.length === 1 && !options[0].text) {
          return { error: `Klausimas "${questionText}" turi turėti įrašytą teisingą atsakymą` };
        }
        if (options.some((o) => !o.text && !o.img)) {
          return { error: `Klausimas "${questionText}" turi tuščią atsakymo variantą` };
        }

        const question = { question: questionText };
        const img = (q.img || '').trim();
        if (img) question.img = img;
        const audio = (q.audio || '').trim();
        if (audio) {
          question.audio = audio;
          const audioStart = Number(q.audioStart);
          const audioEnd = Number(q.audioEnd);
          if (Number.isFinite(audioStart) && audioStart > 0) question.audioStart = audioStart;
          if (Number.isFinite(audioEnd) && audioEnd > 0) question.audioEnd = audioEnd;
          if (question.audioEnd != null && question.audioEnd <= (question.audioStart || 0)) {
            return { error: `Klausimas "${questionText}" turi "iki" laiką didesnį už "nuo" laiką` };
          }
        }
        question.options = options;
        questions.push(question);
      }

      stages.push({ name: stageName, questions });
    }

    return { game: { name, stages } };
  }

  // A game from a file, as the editor form wants it: ids dropped (the
  // server makes its own on save) and the correct option moved first. Files
  // in the server's own shape name it by id in `answer`; portable ones
  // already have it first.
  function toPortableGame(game) {
    return {
      name: game.name,
      stages: (game.stages || []).map((stage) => ({
        name: stage && stage.name,
        questions: ((stage && stage.questions) || []).map((q) => {
          const options = ((q && q.options) || []).slice();
          const correctIdx = q && q.answer ? options.findIndex((o) => o && o.id === q.answer) : -1;
          if (correctIdx > 0) options.unshift(options.splice(correctIdx, 1)[0]);
          // A picture option's text is dropped, as normalizeGamePayload does.
          const out = {
            ...q,
            options: options.map((o) => ({
              text: o && o.img && options.length > 1 ? '' : o && o.text,
              img: o && o.img,
            })),
          };
          delete out.id;
          delete out.answer;
          return out;
        }),
      })),
    };
  }

  // Recognizes every shape a JSON file can hold — a single game ({name,
  // stages}), a list of games (this editor's "export all"), or a keyed map
  // ({ gameId: {name, stages} }, i.e. the server's games.json) — and returns
  // { games: [game, ...] } in the portable, id-less form.
  function extractGamesFromImport(parsed) {
    if (!parsed || typeof parsed !== 'object') return { error: 'Netinkamas failo formatas' };

    const isGame = (g) => g && typeof g === 'object' && Array.isArray(g.stages);
    let list = null;
    if (isGame(parsed)) list = [parsed];
    else if (Array.isArray(parsed)) list = parsed.every(isGame) ? parsed : null;
    else {
      const values = Object.values(parsed);
      list = values.length && values.every(isGame) ? values : null;
    }
    if (!list || !list.length) return { error: 'Faile nerasta atpažįstamų žaidimų' };

    return { games: list.map(toPortableGame) };
  }

  global.QuizGameShared = { generateId, normalizeGamePayload, extractGamesFromImport };
})(window);
