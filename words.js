(() => {
  const $ = (id) => document.getElementById(id);

  const listEl = $("list");
  const emptyStateEl = $("emptyState");
  const searchEl = $("search");
  const countLabel = $("countLabel");
  const showAddFormBtn = $("showAddForm");
  const addForm = $("addForm");
  const newTrigger = $("newTrigger");
  const newReplacement = $("newReplacement");
  const newDef = $("newDef");
  const saveNewWordBtn = $("saveNewWord");
  const cancelNewWordBtn = $("cancelNewWord");
  const autoMarkCheckbox = $("autoMarkCheckbox");
  const thresholdInput = $("thresholdInput");
  const difficultySelect = $("difficultySelect");
  const segButtons = [...document.querySelectorAll(".seg")];

  const BASE_DICTIONARY =
    typeof VOCAB_DICTIONARY !== "undefined" ? VOCAB_DICTIONARY : {};

  const hasChrome = typeof chrome !== "undefined" && !!chrome.storage;

  let disabledTriggers = [];
  let customWords = {};
  let learnedWords = [];
  let difficulty = "hard";
  let autoMark = false;
  let autoMarkThreshold = 10;
  let searchTerm = "";

  // The popup links straight into a filter: clicking the water opens the
  // learned words, clicking the pale part opens what's left to learn.
  const VALID_FILTERS = ["all", "learning", "learned", "difficult"];
  const requested = new URLSearchParams(location.search).get("filter");
  let filter = VALID_FILTERS.includes(requested) ? requested : "all";

  const DEFAULTS = {
    disabledTriggers: [],
    customWords: {},
    learnedWords: [],
    difficulty: "hard",
    autoMark: false,
    autoMarkThreshold: 10,
  };

  function save(patch) {
    if (hasChrome) chrome.storage.sync.set(patch);
  }

  function loadState(cb) {
    if (!hasChrome) return cb();
    chrome.storage.sync.get(DEFAULTS, (res) => {
      disabledTriggers = res.disabledTriggers;
      customWords = res.customWords;
      learnedWords = res.learnedWords || [];
      difficulty = res.difficulty;
      autoMark = !!res.autoMark;
      autoMarkThreshold = res.autoMarkThreshold || 10;

      autoMarkCheckbox.checked = autoMark;
      thresholdInput.value = autoMarkThreshold;
      difficultySelect.value = difficulty;
      cb();
    });
  }

  function allEntries() {
    const base = Object.keys(BASE_DICTIONARY).map((trig) => ({
      trigger: trig,
      word: BASE_DICTIONARY[trig].word,
      def: BASE_DICTIONARY[trig].def,
      hard: !!BASE_DICTIONARY[trig].hard,
      custom: false,
    }));
    const custom = Object.keys(customWords).map((trig) => ({
      trigger: trig,
      word: customWords[trig].word,
      def: customWords[trig].def || "",
      hard: false,
      custom: true,
    }));
    return [...custom, ...base].sort((a, b) =>
      a.trigger.localeCompare(b.trigger)
    );
  }

  function updateCount() {
    const total = Object.keys(BASE_DICTIONARY).length + Object.keys(customWords).length;
    countLabel.textContent = total + (total === 1 ? " word" : " words");
  }

  function matchesFilter(e) {
    const isLearned = learnedWords.includes(e.trigger);
    if (filter === "learned") return isLearned;
    if (filter === "learning") return !isLearned;
    if (filter === "difficult") return e.hard;
    return true;
  }

  function render() {
    const term = searchTerm.toLowerCase();
    const entries = allEntries()
      .filter((e) =>
        !term ||
        e.trigger.toLowerCase().includes(term) ||
        e.word.toLowerCase().includes(term) ||
        e.def.toLowerCase().includes(term)
      )
      .filter(matchesFilter);

    listEl.innerHTML = "";
    listEl.hidden = entries.length === 0;
    emptyStateEl.hidden = entries.length > 0;

    for (const e of entries) {
      const enabled = e.custom || !disabledTriggers.includes(e.trigger);
      const isLearned = learnedWords.includes(e.trigger);

      const row = document.createElement("div");
      row.className = "word-row" + (enabled ? "" : " word-row-disabled");

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "word-toggle";
      toggle.checked = enabled;
      toggle.setAttribute(
        "aria-label",
        (enabled ? "Disable" : "Enable") + " " + e.word
      );
      toggle.title = e.custom
        ? "Custom words are always on — delete it instead."
        : enabled
        ? "Disable this word"
        : "Enable this word";
      if (e.custom) toggle.disabled = true;
      toggle.addEventListener("change", () => {
        if (e.custom) return;
        disabledTriggers = toggle.checked
          ? disabledTriggers.filter((t) => t !== e.trigger)
          : [...disabledTriggers, e.trigger];
        save({ disabledTriggers });
        row.classList.toggle("word-row-disabled", !toggle.checked);
      });
      row.appendChild(toggle);

      const text = document.createElement("div");
      text.className = "word-text";

      // original → replacement, on one line
      const line = document.createElement("div");
      line.className = "word-line";

      const triggerSpan = document.createElement("span");
      triggerSpan.className = "word-trigger";
      triggerSpan.textContent = e.trigger;
      line.appendChild(triggerSpan);

      const arrow = document.createElement("span");
      arrow.className = "word-arrow";
      arrow.textContent = "→";
      line.appendChild(arrow);

      const replSpan = document.createElement("span");
      replSpan.className = "word-replacement";
      replSpan.textContent = e.word;
      line.appendChild(replSpan);

      if (e.custom) {
        const tag = document.createElement("span");
        tag.className = "badge";
        tag.textContent = "Custom";
        line.appendChild(tag);
      } else if (e.hard) {
        const tag = document.createElement("span");
        tag.className = "badge";
        tag.textContent = "Difficult";
        line.appendChild(tag);
      }
      if (isLearned) {
        const tag = document.createElement("span");
        tag.className = "badge badge-learned";
        tag.textContent = "Learned";
        line.appendChild(tag);
      }
      text.appendChild(line);

      if (e.def) {
        const defEl = document.createElement("span");
        defEl.className = "word-def";
        defEl.textContent = e.def;
        text.appendChild(defEl);
      }
      row.appendChild(text);

      if (e.custom) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "word-delete";
        del.textContent = "×";
        del.setAttribute("aria-label", "Remove " + e.word);
        del.title = "Remove custom word";
        del.addEventListener("click", () => {
          delete customWords[e.trigger];
          save({ customWords });
          updateCount();
          render();
        });
        row.appendChild(del);
      }

      listEl.appendChild(row);
    }
  }

  /* ---------------- Toolbar ---------------- */

  searchEl.addEventListener("input", () => {
    searchTerm = searchEl.value.trim();
    render();
  });

  segButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      filter = btn.dataset.filter;
      segButtons.forEach((b) =>
        b.setAttribute("aria-selected", String(b === btn))
      );
      render();
    });
    btn.addEventListener("keydown", (e) => {
      const i = segButtons.indexOf(btn);
      if (e.key === "ArrowRight") {
        e.preventDefault();
        segButtons[(i + 1) % segButtons.length].focus();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        segButtons[(i - 1 + segButtons.length) % segButtons.length].focus();
      }
    });
  });

  showAddFormBtn.addEventListener("click", () => {
    addForm.hidden = !addForm.hidden;
    if (!addForm.hidden) newTrigger.focus();
  });

  cancelNewWordBtn.addEventListener("click", () => {
    addForm.hidden = true;
    newTrigger.value = newReplacement.value = newDef.value = "";
    showAddFormBtn.focus();
  });

  saveNewWordBtn.addEventListener("click", () => {
    const trig = newTrigger.value.trim().toLowerCase();
    const word = newReplacement.value.trim();
    const def = newDef.value.trim();
    if (!trig || !word) return;
    customWords[trig] = { word, def };
    save({ customWords });
    newTrigger.value = newReplacement.value = newDef.value = "";
    addForm.hidden = true;
    updateCount();
    render();
  });

  [newTrigger, newReplacement, newDef].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveNewWordBtn.click();
    });
  });

  /* ---------------- Settings ---------------- */

  autoMarkCheckbox.addEventListener("change", () => {
    autoMark = autoMarkCheckbox.checked;
    save({ autoMark });
  });

  thresholdInput.addEventListener("change", () => {
    const n = parseInt(thresholdInput.value, 10);
    autoMarkThreshold = Number.isFinite(n) ? Math.min(99, Math.max(1, n)) : 10;
    thresholdInput.value = autoMarkThreshold;
    save({ autoMarkThreshold });
  });

  // Which tier the content script substitutes while browsing. This is a
  // behavior setting, separate from the view filters above.
  difficultySelect.addEventListener("change", () => {
    difficulty = difficultySelect.value;
    save({ difficulty });
  });

  function syncFilterButtons() {
    segButtons.forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.filter === filter))
    );
  }

  loadState(() => {
    syncFilterButtons();
    updateCount();
    render();
  });
})();
