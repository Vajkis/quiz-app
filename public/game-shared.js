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

  // A question's kind: 'choice' (options, the first correct), 'text' (a
  // single option, whose text players type in), 'yesno' (fixed Taip / Ne,
  // answer 'yes' or 'no'), or 'chain' (several clues, each with its own typed
  // answer, in order). Games saved before there was a type field are told
  // apart by their option count, as they always were.
  const QUESTION_TYPES = ['choice', 'text', 'yesno', 'chain'];
  function questionType(q) {
    if (q && QUESTION_TYPES.includes(q.type)) return q.type;
    return q && Array.isArray(q.options) && q.options.length === 1 ? 'text' : 'choice';
  }

  // The optional extra answer players type in (e.g. the artist, after the
  // song), worth a point only when the main answer is right. Its question
  // is optional; with neither filled in, there's no extra answer at all.
  function normalizeBonus(bonus) {
    const question = ((bonus && bonus.question) || '').trim();
    const answer = ((bonus && bonus.answer) || '').trim();
    if (!question && !answer) return null;
    if (!answer) return { error: 'įrašyk papildomą atsakymą' };
    return { question, answer };
  }

  // Validates and tidies an editor form submission into the portable game
  // format: { name, rules?: [string], stages: [{ name, questions: [{ type, question, img?,
  // audio?, audioStart?, audioEnd?, bonus?: { question, answer }, and by
  // type: options: [{ text, img? }] (choice/text), answer: 'yes'|'no'
  // (yesno) or links: [{ clue, answer }] (chain) }] }] }, the first option
  // being the correct one (the editor's own convention — see
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
        if (!q) return { error: 'Kiekvienas klausimas turi turėti tekstą' };
        const type = questionType(q);
        const questionText = (q.question || '').trim();
        // A chain's clues are its question — a title of its own is optional.
        if (!questionText && type !== 'chain') return { error: 'Kiekvienas klausimas turi turėti tekstą' };
        const label = questionText || 'Grandinėlė';
        const chainLabel = questionText ? `Grandinėlė "${questionText}"` : 'Grandinėlė';
        const question = { type, question: questionText };

        if (type === 'choice' || type === 'text') {
          const authored = Array.isArray(q.options) ? q.options : [];
          if (type === 'choice' && authored.length < 2) {
            return { error: `Klausimas "${label}" turi turėti bent 2 atsakymo variantus` };
          }
          if (type === 'text' && authored.length !== 1) {
            return { error: `Klausimas "${label}" turi turėti įrašytą teisingą atsakymą` };
          }
          const options = authored.map((o) => {
            const option = { text: ((o && o.text) || '').trim() };
            const img = ((o && o.img) || '').trim();
            if (img) option.img = img;
            return option;
          });
          // A picture option has no text at all (it's shown by its letter;
          // any text would give the answer away, even as an alt); a
          // typed-answer question's single option is the answer, so it does.
          if (type === 'choice') {
            options.forEach((o) => {
              if (o.img) o.text = '';
            });
          }
          if (type === 'text' && !options[0].text) {
            return { error: `Klausimas "${label}" turi turėti įrašytą teisingą atsakymą` };
          }
          if (options.some((o) => !o.text && !o.img)) {
            return { error: `Klausimas "${label}" turi tuščią atsakymo variantą` };
          }
          question.options = options;
        } else if (type === 'yesno') {
          if (q.answer !== 'yes' && q.answer !== 'no') {
            return { error: `Klausimas "${label}": pažymėk teisingą atsakymą – Taip arba Ne` };
          }
          question.answer = q.answer;
        } else {
          const links = (Array.isArray(q.links) ? q.links : []).map((l) => ({
            clue: ((l && l.clue) || '').trim(),
            answer: ((l && l.answer) || '').trim(),
          }));
          if (links.length < 2) return { error: `${chainLabel} turi turėti bent 2 užuominas` };
          if (links.some((l) => !l.clue || !l.answer)) {
            return { error: `${chainLabel}: kiekviena užuomina turi turėti tekstą ir atsakymą` };
          }
          question.links = links;
        }

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
            return { error: `Klausimas "${label}" turi "iki" laiką didesnį už "nuo" laiką` };
          }
        }

        const bonus = normalizeBonus(q.bonus);
        if (bonus && bonus.error) return { error: `Klausimas "${label}": ${bonus.error}` };
        if (bonus) question.bonus = bonus;
        questions.push(question);
      }

      stages.push({ name: stageName, questions });
    }

    const game = { name };
    const rules = normalizeRules(body.rules);
    if (rules.length) game.rules = rules;
    game.stages = stages;
    return { game };
  }

  // The game's rules, one per line, shown on their own slide right after
  // the game's name — optional; blank lines are dropped.
  function normalizeRules(rules) {
    return (Array.isArray(rules) ? rules : [])
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter(Boolean);
  }

  // A game from a file, as the editor form wants it: ids dropped (the
  // server makes its own on save) and the correct option moved first. Files
  // in the server's own shape name it by id in `answer`; portable ones
  // already have it first.
  function toPortableGame(game) {
    return {
      name: game.name,
      rules: normalizeRules(game.rules),
      stages: (game.stages || []).map((stage) => ({
        name: stage && stage.name,
        questions: ((stage && stage.questions) || []).map((q) => {
          const type = questionType(q);
          // A yes/no question keeps its 'yes'/'no' answer and a chain its
          // links as they are — neither has options or option ids.
          if (type === 'yesno' || type === 'chain') {
            const out = { ...q, type };
            delete out.id;
            delete out.options;
            if (type === 'chain') delete out.answer;
            return out;
          }
          const options = ((q && q.options) || []).slice();
          const correctIdx = q && q.answer ? options.findIndex((o) => o && o.id === q.answer) : -1;
          if (correctIdx > 0) options.unshift(options.splice(correctIdx, 1)[0]);
          // A picture option's text is dropped, as normalizeGamePayload does.
          const out = {
            ...q,
            type,
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

  global.QuizGameShared = { generateId, questionType, normalizeGamePayload, extractGamesFromImport };
})(window);
