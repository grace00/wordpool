(() => {
  // VOCAB_DICTIONARY comes from dictionary.js, loaded before this file. This
  // is the built-in set; the runtime DICTIONARY below is this minus any
  // words the user disabled, plus any custom words they added — both
  // managed from words.html and stored in chrome.storage.
  const BASE_DICTIONARY =
    typeof VOCAB_DICTIONARY !== "undefined" ? VOCAB_DICTIONARY : {};
  if (Object.keys(BASE_DICTIONARY).length === 0) return;

  const MAX_REPLACEMENTS = 40; // safety net only; density is controlled below
  const MIN_SENTENCES_BETWEEN_SWAPS = 3; // roughly "one swap per paragraph"
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEXTAREA",
    "INPUT",
    "CODE",
    "PRE",
  ]);

  // Built once storage has loaded, in start() below.
  let DICTIONARY = {};
  let wordPattern = null;
  const sentenceEnderPattern = /[.!?]+/g;

  function buildDictionary(disabledTriggers, customWords, difficulty) {
    const merged = {};
    for (const trig of Object.keys(BASE_DICTIONARY)) {
      if (disabledTriggers.includes(trig)) continue;
      const entry = BASE_DICTIONARY[trig];
      if (difficulty === "hard" && !entry.hard) continue;
      merged[trig] = entry;
    }
    for (const trig of Object.keys(customWords)) {
      merged[trig] = customWords[trig];
    }
    return merged;
  }

  // Pick one random word for the popup's "word of the day" display. This
  // runs once per content-script injection — i.e. once per page load or
  // refresh — regardless of whether this site is on the swap allow-list,
  // so the popup always has something to show. Sent to the background
  // worker (not written to storage directly) so it can be keyed by tab id.
  function announceWordOfDay() {
    const keys = Object.keys(DICTIONARY);
    if (keys.length === 0) return;
    const trigger = keys[Math.floor(Math.random() * keys.length)];
    const entry = DICTIONARY[trigger];
    try {
      chrome.runtime.sendMessage({
        type: "wordOfDay",
        payload: { word: entry.word, def: entry.def, trigger },
      });
    } catch (e) {
      // Extension context can be unavailable in rare edge cases; harmless.
    }
  }

  // Every mutation of the shared arrays goes through this queue.
  //
  // learnedWords and disabledTriggers are read-modify-written from three
  // places, and trackExposure() alone fires once per swapped word (dozens of
  // times per page load). Unqueued, each caller holds a snapshot taken before
  // the others' writes land, so the last write wins and silently erases the
  // rest. That is why a word marked learned could vanish from the count.
  //
  // Chaining on a single promise means each mutation reads the state left by
  // the one before it.
  let storageQueue = Promise.resolve();
  let lastWriteError = null;
  function updateStorage(defaults, mutate) {
    storageQueue = storageQueue
      .then(
        () =>
          new Promise((resolve) => {
            // After the extension is reloaded, content scripts already
            // running in open tabs keep their old context, and every
            // chrome.* call throws. Without this the failure is invisible:
            // the card animates away as though the word had been saved.
            if (!chrome.runtime || !chrome.runtime.id) {
              lastWriteError = "Extension context invalidated. Reload the page.";
              console.warn("[Wordpool] " + lastWriteError);
              return resolve();
            }
            try {
              chrome.storage.sync.get(defaults, (res) => {
              const patch = mutate(res);
              if (!patch) return resolve();
                chrome.storage.sync.set(patch, () => {
                  // storage.sync enforces a write quota. Without this check a
                  // rejected write looks identical to a successful one, and
                  // the change is lost with no sign of it.
                  const err = chrome.runtime && chrome.runtime.lastError;
                  if (err) {
                    lastWriteError = err.message || String(err);
                    console.warn("[Wordpool] write failed: " + lastWriteError);
                  }
                  resolve();
                });
              });
            } catch (e) {
              lastWriteError = e && e.message ? e.message : String(e);
              console.warn("[Wordpool] " + lastWriteError);
              resolve();
            }
          })
      )
      .catch(() => {});
    return storageQueue;
  }

  // Exposure counts were written once per swapped word, which is roughly
  // forty storage.sync writes per page load. Chrome allows 120 writes a
  // minute, so three quick page loads exhausted the quota and every later
  // write failed silently, including the one that records a learned word.
  // Counts now accumulate in memory and flush once.
  const pendingExposures = Object.create(null);
  let exposureFlushTimer = null;

  // Small diagnostic surface: run window.__wordpoolStatus() in the page
  // console to see whether this tab's script can still reach storage.
  if (typeof window !== "undefined") {
    window.__wordpoolStatus = () => ({
      contextAlive: !!(chrome.runtime && chrome.runtime.id),
      lastWriteError,
      wordsInPlay: Object.keys(DICTIONARY).length,
      swapsOnPage: document.querySelectorAll(".vocab-swap-ext").length,
      pendingExposures: Object.keys(pendingExposures).length,
    });
  }

  function trackExposure(trigger) {
    pendingExposures[trigger] = (pendingExposures[trigger] || 0) + 1;
    if (exposureFlushTimer) return;
    exposureFlushTimer = setTimeout(flushExposures, 2000);
  }

  function flushExposures() {
    clearTimeout(exposureFlushTimer);
    exposureFlushTimer = null;

    const batch = { ...pendingExposures };
    for (const k of Object.keys(pendingExposures)) delete pendingExposures[k];
    if (Object.keys(batch).length === 0) return;

    updateStorage(
      {
        autoMark: false,
        autoMarkThreshold: 10,
        exposureCounts: {},
        learnedWords: [],
        disabledTriggers: [],
      },
      (res) => {
        if (!res.autoMark) return null;

        const counts = { ...(res.exposureCounts || {}) };
        const threshold = Math.max(1, res.autoMarkThreshold || 10);
        const learned = [...(res.learnedWords || [])];
        const disabled = [...(res.disabledTriggers || [])];
        let graduated = false;

        for (const [trigger, n] of Object.entries(batch)) {
          counts[trigger] = (counts[trigger] || 0) + n;
          if (counts[trigger] < threshold) continue;
          if (!learned.includes(trigger)) learned.push(trigger);
          if (!disabled.includes(trigger)) disabled.push(trigger);
          delete DICTIONARY[trigger];
          graduated = true;
        }

        if (graduated) {
          const keys = Object.keys(DICTIONARY);
          wordPattern =
            keys.length > 0
              ? new RegExp("\\b(" + keys.join("|") + ")\\b", "gi")
              : null;
        }

        return { exposureCounts: counts, learnedWords: learned, disabledTriggers: disabled };
      }
    );
  }

  // Do not lose a partial batch when the page goes away.
  window.addEventListener("pagehide", flushExposures);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushExposures();
  });

  let globalCount = 0;
  let stopped = false;
  // Running "reading position" in sentences, across the whole page scan (in
  // document order), so swaps stay spaced out instead of clustering in one
  // paragraph. Starts at -Infinity so the very first match is never blocked.
  let sentenceCounter = 0;
  let lastSwapSentence = -Infinity;
  // Repeated passes (retry timers + MutationObserver) re-walk the whole
  // page; without this, already-seen plain text would get its sentences
  // re-counted every pass and inflate sentenceCounter. Each text node is
  // only ever evaluated once.
  const seenTextNodes = new WeakSet();
  // Shadow roots (many modern sites use shadow-DOM web components) don't
  // inherit the page-level stylesheet — style encapsulation blocks it. Each
  // shadow root needs its own copy injected directly, or swaps render
  // invisibly.
  const styledShadowRoots = new WeakSet();
  const SHADOW_STYLE_CSS = `
    .vocab-swap-ext {
      border-bottom: 2px dotted #d9631f;
      cursor: pointer;
    }
    @media (prefers-color-scheme: dark) {
      .vocab-swap-ext {
        border-bottom-color: #ffb37a;
      }
    }
  `;

  function ensureShadowStyle(shadowRoot) {
    if (styledShadowRoots.has(shadowRoot)) return;
    styledShadowRoots.add(shadowRoot);
    const style = document.createElement("style");
    style.textContent = SHADOW_STYLE_CSS;
    shadowRoot.appendChild(style);
  }

  function matchCase(original, replacement) {
    if (original[0] !== original[0].toLowerCase()) {
      return replacement[0].toUpperCase() + replacement.slice(1);
    }
    return replacement;
  }

  function shouldSkip(parent) {
    if (!parent) return true;
    if (SKIP_TAGS.has(parent.tagName)) return true;
    if (parent.isContentEditable) return true;
    if (
      parent.closest &&
      parent.closest(
        '[contenteditable="true"], script, style, textarea, code, pre, input'
      )
    ) {
      return true;
    }
    // Covers both already-swapped words and our own click-to-reveal
    // tooltip bubble. Without the latter exclusion, appending the tooltip
    // to document.body triggers the MutationObserver, which rescans the
    // page and can match dictionary words inside the tooltip's own text
    // (e.g. a tooltip reading "Honestly" gets swapped to "Candidly").
    if (
      parent.closest &&
      parent.closest(".vocab-swap-ext, .vocab-tooltip-ext, .vocab-card-ext")
    ) {
      return true;
    }
    return false;
  }

  function replaceInTextNode(node) {
    if (stopped || globalCount >= MAX_REPLACEMENTS || !wordPattern) return;
    if (seenTextNodes.has(node)) return;
    seenTextNodes.add(node);
    const text = node.data;
    if (!text || !text.trim()) return;

    wordPattern.lastIndex = 0;
    const wordMatches = [...text.matchAll(wordPattern)];

    sentenceEnderPattern.lastIndex = 0;
    const enderEnds = [...text.matchAll(sentenceEnderPattern)].map(
      (m) => m.index + m[0].length
    );

    if (wordMatches.length === 0) {
      // No dictionary words here, but still track sentence boundaries so
      // later nodes know how much "reading distance" has passed.
      sentenceCounter += enderEnds.length;
      return;
    }

    const parent = node.parentElement;
    if (shouldSkip(parent)) {
      sentenceCounter += enderEnds.length;
      return;
    }

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let replacedAny = false;
    let enderPtr = 0;

    for (const m of wordMatches) {
      while (enderPtr < enderEnds.length && enderEnds[enderPtr] <= m.index) {
        sentenceCounter++;
        enderPtr++;
      }

      if (stopped || globalCount >= MAX_REPLACEMENTS) break;
      const original = m[0];
      const key = original.toLowerCase();
      const entry = DICTIONARY[key];
      if (!entry) continue;

      // \b treats "-" and "'" as non-word boundaries, so "allow-list" or
      // "haven't" would otherwise match "list" / "haven" and produce
      // "allow-enumerate" / "sanctuary't". Skip matches glued to a hyphen
      // or apostrophe on either side — they're fragments of a compound
      // word or contraction, not the standalone word.
      const start = m.index;
      const charBefore = text[start - 1];
      const charAfter = text[start + original.length];
      const isGlueChar = (c) => c === "-" || c === "'" || c === "’";
      if (isGlueChar(charBefore) || isGlueChar(charAfter)) continue;

      if (sentenceCounter - lastSwapSentence < MIN_SENTENCES_BETWEEN_SWAPS) {
        continue;
      }

      const beforeNode = document.createTextNode(text.slice(lastIndex, start));
      seenTextNodes.add(beforeNode);
      frag.appendChild(beforeNode);

      const span = document.createElement("span");
      span.className = "vocab-swap-ext";
      const replacement = matchCase(original, entry.word);
      span.dataset.original = original;
      // Canonical replacement, kept out of band so nothing downstream has to
      // read it back off the DOM (the hover overlay lives inside this span).
      span.dataset.word = replacement;
      span.dataset.trigger = key;
      span.textContent = replacement;
      frag.appendChild(span);

      // Track exposure for auto-mark
      trackExposure(key);

      lastIndex = start + original.length;
      globalCount++;
      replacedAny = true;
      lastSwapSentence = sentenceCounter;
    }

    while (enderPtr < enderEnds.length) {
      sentenceCounter++;
      enderPtr++;
    }

    if (!replacedAny) return;
    const afterNode = document.createTextNode(text.slice(lastIndex));
    seenTextNodes.add(afterNode);
    frag.appendChild(afterNode);
    node.replaceWith(frag);

    if (globalCount >= MAX_REPLACEMENTS) {
      stopped = true;
      if (observer) observer.disconnect();
    }
  }

  function processRoot(root) {
    if (stopped || !root) return;
    if (root instanceof ShadowRoot) ensureShadowStyle(root);
    const iter = document.createNodeIterator(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let n;
    while ((n = iter.nextNode())) textNodes.push(n);
    for (const tn of textNodes) {
      replaceInTextNode(tn);
      if (stopped) break;
    }

    if (stopped) return;
    if (root.querySelectorAll) {
      const all = root.querySelectorAll("*");
      for (const el of all) {
        if (el.shadowRoot) processRoot(el.shadowRoot);
        if (stopped) break;
      }
    }
  }

  function runPass() {
    if (stopped) return;
    processRoot(document.body);
  }

  let debounceTimer = null;
  let observer = null;

  function startObserving() {
    observer = new MutationObserver(() => {
      if (stopped) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runPass, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Clicking a swapped word reveals ONLY the original word it replaced, in
  // a small floating bubble — nothing else (no definition, no arrow).
  let activeTooltipEl = null;
  let activeTooltipSpan = null;

  function detachCard(card) {
    if (card && card.__reposition) {
      window.removeEventListener("scroll", card.__reposition, true);
      window.removeEventListener("resize", card.__reposition);
      delete card.__reposition;
    }
  }

  function hideOriginalTooltip() {
    if (activeTooltipEl) {
      detachCard(activeTooltipEl);
      activeTooltipEl.remove();
      activeTooltipEl = null;
      activeTooltipSpan = null;
    }
  }

  // Finds every already-swapped span for a given trigger, including ones
  // sitting inside shadow roots (querySelectorAll alone can't see those).
  function findSwapSpansByTrigger(root, trigger, results) {
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll(".vocab-swap-ext")) {
        if (el.dataset.trigger === trigger) results.push(el);
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) findSwapSpansByTrigger(el.shadowRoot, trigger, results);
      }
    }
    return results;
  }

  function markWordAsLearned(trigger, card, originEl) {
    if (!card) return;

    // Detach the card from the tooltip bookkeeping before anything else.
    // removeWordFromPool() below ends in hideOriginalTooltip(), which would
    // otherwise .remove() this very element synchronously — the node would be
    // gone before the browser painted a frame, so no transition could run.
    activeTooltipEl = null;
    activeTooltipSpan = null;
    detachCard(card);

    // Save first, animate second: the record is what matters if the tab is
    // closed mid-animation.
    updateStorage({ learnedWords: [], disabledTriggers: [] }, (res) => {
      const learned = res.learnedWords || [];
      const disabled = res.disabledTriggers || [];
      if (learned.includes(trigger) && disabled.includes(trigger)) return null;
      return {
        learnedWords: learned.includes(trigger) ? learned : [...learned, trigger],
        disabledTriggers: disabled.includes(trigger)
          ? disabled
          : [...disabled, trigger],
      };
    });

    spawnRaindrop(originEl || card);
    dismissCard(card);

    // Remove from this page's memory and revert the swapped text.
    removeWordFromPool(trigger);
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // A small cyan droplet detaches from whatever was clicked and falls a short
  // way before fading. The tooltip itself is never morphed — this is a
  // separate element layered over the page.
  function spawnRaindrop(originEl) {
    if (prefersReducedMotion()) return;

    const r = originEl.getBoundingClientRect();
    const size = 10;
    const drop = document.createElement("div");
    drop.className = "vocab-drop-ext";
    Object.assign(drop.style, {
      position: "fixed",
      left: r.left + r.width / 2 - size / 2 + "px",
      // Starts tucked under the word's baseline so it reads as emerging
      // from behind the text rather than dropping onto it.
      top: r.bottom - size * 0.7 + "px",
      // A square box: "50% 50% 50% 0" only makes a symmetric teardrop when
      // width and height match — the old 8x11 box is what skewed it.
      width: size + "px",
      height: size + "px",
      background: "#46B3D0",
      // Teardrop: three round corners, one point.
      borderRadius: "50% 50% 50% 0",
      // translateY is written before rotate so the fall stays vertical
      // instead of tracking the rotated axis.
      transform: "translateY(0) rotate(-45deg)",
      opacity: "0.9",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    document.body.appendChild(drop);

    requestAnimationFrame(() => {
      drop.style.transition =
        "transform .34s cubic-bezier(.55,0,.85,.4), opacity .34s ease-in";
      drop.style.transform = "translateY(16px) rotate(-45deg)";
      drop.style.opacity = "0";
    });

    setTimeout(() => drop.remove(), 420);
  }

  // The tooltip lifts slightly and fades out; it keeps its shape throughout.
  function dismissCard(card) {
    if (prefersReducedMotion()) {
      card.remove();
      return;
    }
    card.style.pointerEvents = "none";
    card.style.willChange = "transform, opacity";
    requestAnimationFrame(() => {
      card.style.transition = "opacity .2s ease, transform .2s ease";
      card.style.opacity = "0";
      card.style.transform = "translateY(-6px)";
    });
    setTimeout(() => card.remove(), 300);
  }

  function removeWordFromPool(trigger) {
    updateStorage({ disabledTriggers: [] }, (res) => {
      const disabled = res.disabledTriggers || [];
      return disabled.includes(trigger)
        ? null
        : { disabledTriggers: [...disabled, trigger] };
    });

    // Also drop it from THIS page's already-loaded dictionary and rebuild
    // the match pattern. Without this, the MutationObserver's next rescan
    // still has the word in memory and immediately swaps the reverted text
    // right back.
    delete DICTIONARY[trigger];
    const remainingKeys = Object.keys(DICTIONARY);
    wordPattern =
      remainingKeys.length > 0
        ? new RegExp("\\b(" + remainingKeys.join("|") + ")\\b", "gi")
        : null;

    // Revert every instance of this word currently on the page, not just
    // the one the tooltip was opened on.
    for (const span of findSwapSpansByTrigger(document, trigger, [])) {
      const plain = document.createTextNode(span.dataset.original);
      seenTextNodes.add(plain);
      span.replaceWith(plain);
    }
    hideOriginalTooltip();
  }

  const CARD_GAP = 8; // space between the word and the card
  const CARD_EDGE = 8; // minimum clearance from the viewport edge

  // Places the card next to its word: below by default, flipped above when
  // there isn't room, and shifted horizontally to stay on screen. Never
  // centered on the page, and never covering the word it belongs to.
  function positionCard(card, span) {
    const word = span.getBoundingClientRect();
    // A word wrapped across two lines reports a tall union rect; the caret
    // should track the fragment the user actually clicked.
    const rects = span.getClientRects();
    const anchor = rects.length ? rects[0] : word;
    const box = card.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    const roomBelow = vh - word.bottom;
    const roomAbove = word.top;
    const placeBelow =
      roomBelow >= box.height + CARD_GAP + CARD_EDGE || roomBelow >= roomAbove;

    let top = placeBelow
      ? word.bottom + CARD_GAP
      : word.top - box.height - CARD_GAP;
    top = Math.max(CARD_EDGE, Math.min(top, vh - box.height - CARD_EDGE));

    let left = anchor.left + anchor.width / 2 - box.width / 2;
    left = Math.max(CARD_EDGE, Math.min(left, vw - box.width - CARD_EDGE));

    card.style.top = Math.round(top) + "px";
    card.style.left = Math.round(left) + "px";
    card.dataset.placement = placeBelow ? "bottom" : "top";

    // Caret follows the word even after the card has been shifted sideways.
    const caret = card.querySelector(".vocab-card-caret");
    if (caret) {
      const center = anchor.left + anchor.width / 2 - left;
      const clamped = Math.max(10, Math.min(center - 4, box.width - 18));
      caret.style.left = Math.round(clamped) + "px";
      // Hide it if the card had to move far from the word.
      caret.style.display =
        center < 0 || center > box.width ? "none" : "block";
    }
  }

  function showDefinitionCard(span, entry) {
    // Only one popover at a time.
    hideOriginalTooltip();

    const card = document.createElement("div");
    card.className = "vocab-card-ext";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Definition");

    // Title comes from the vocabulary entry. It must not be span.textContent:
    // the hover overlay that reveals the original word is appended *inside*
    // this span, so textContent runs the replacement and the original
    // together ("minutiaedetails").
    const canonical = (entry && entry.word) || span.dataset.word || "";
    const heading = document.createElement("div");
    heading.className = "vocab-card-word";
    heading.textContent = canonical.replace(/\s+/g, " ").trim();
    card.appendChild(heading);

    const definition = document.createElement("div");
    definition.className = "vocab-card-def";
    // Numbered senses — "(1) … (2) …" — are kept exactly as authored.
    definition.textContent = (entry && entry.def) || "No definition";
    card.appendChild(definition);

    const knewLink = document.createElement("button");
    knewLink.type = "button";
    knewLink.className = "vocab-card-action";
    knewLink.textContent = "I knew this";
    knewLink.addEventListener("click", (e) => {
      e.stopPropagation();
      markWordAsLearned(span.dataset.trigger, card, span);
    });
    card.appendChild(knewLink);

    const caret = document.createElement("div");
    caret.className = "vocab-card-caret";
    card.appendChild(caret);

    // Clicks inside the card must not reach the document-level dismiss.
    card.addEventListener("click", (e) => e.stopPropagation());

    document.body.appendChild(card);
    positionCard(card, span);

    // Keep it anchored while the page moves under it.
    const reposition = () => {
      if (!card.isConnected) return;
      positionCard(card, span);
    };
    card.__reposition = reposition;
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    activeTooltipEl = card;
    activeTooltipSpan = span;
  }

  function showOriginalTooltip(span) {
    const entry = DICTIONARY[span.dataset.trigger];
    showDefinitionCard(span, entry);
  }

  // The box a text node's glyphs actually occupy. Element rects include
  // padding and line-box leading; a Range over the text does not, so two
  // Range rects in the same font can be compared directly.
  function textRect(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.data) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    range.detach && range.detach();
    return rect && rect.height ? rect : null;
  }

  function setupTooltipHandlers() {
    document.addEventListener("click", (e) => {
      const path = e.composedPath ? e.composedPath() : [e.target];
      const span = path.find(
        (el) => el.classList && el.classList.contains("vocab-swap-ext")
      );
      if (span) {
        if (activeTooltipSpan === span) {
          hideOriginalTooltip();
        } else {
          showOriginalTooltip(span);
          span.classList.add("vocab-viewed-ext");
        }
      } else {
        hideOriginalTooltip();
      }
    });
    document.addEventListener("mouseenter", (e) => {
      const path = e.composedPath ? e.composedPath() : [e.target];
      const span = path.find(
        (el) => el.classList && el.classList.contains("vocab-swap-ext")
      );
      if (span && span !== activeTooltipSpan && !span.dataset.revealed) {
        // Swap the text in place so the original reads as ordinary prose.
        //
        // The word must never get NARROWER while hovered. If it did, the text
        // after it would slide left, out from under the cursor, firing
        // mouseleave -> restore -> grow -> mouseenter, and the word would
        // flicker between the two forms. So the space the replacement
        // occupied is held open with padding when the original is shorter.
        // A longer original is allowed to push the line along, since there is
        // nowhere else for it to go.
        const singleLine = span.getClientRects().length === 1;
        const widthBefore = singleLine ? span.getBoundingClientRect().width : 0;

        span.dataset.revealed = "1";
        span.textContent = span.dataset.original;
        span.title = "Click for full definition";

        if (singleLine && span.getClientRects().length === 1) {
          const shrunkBy = widthBefore - span.getBoundingClientRect().width;
          if (shrunkBy > 0.5) span.style.paddingRight = shrunkBy + "px";
        }

        const restore = () => {
          if (span.dataset.word) span.textContent = span.dataset.word;
          span.style.paddingRight = "";
          delete span.dataset.revealed;
          span.removeEventListener("mouseleave", restore);
        };
        span.addEventListener("mouseleave", restore);
      }
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideOriginalTooltip();
    });
    window.addEventListener("scroll", hideOriginalTooltip, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", hideOriginalTooltip);
  }

  function init() {
    runPass();
    startObserving();
    setupTooltipHandlers();
    [500, 1200, 2500, 4500].forEach((delay) => setTimeout(runPass, delay));
  }

  function hostnameAllowed(hostname, allowList) {
    return allowList.some(
      (site) => hostname === site || hostname.endsWith("." + site)
    );
  }

  function start() {
    chrome.storage.sync.get(
      // Default to "hard" (Advanced) for anyone who hasn't chosen yet —
      // the Standard tier turned out to feel too easy for most people who
      // bother installing this.
      {
        allowedSites: [],
        disabledTriggers: [],
        customWords: {},
        difficulty: "hard",
        paused: false,
      },
      (result) => {
        DICTIONARY = buildDictionary(
          result.disabledTriggers,
          result.customWords,
          result.difficulty
        );

        // Reported before any of the gates below. Pausing swapping, or having
        // no words left to swap, should not also blank the popup's word of the
        // day — those are separate concerns and it read as a disappearing UI.
        announceWordOfDay();

        // "Pause everywhere" in the popup's overflow menu.
        if (result.paused) return;
        if (Object.keys(DICTIONARY).length === 0) return;
        wordPattern = new RegExp(
          "\\b(" + Object.keys(DICTIONARY).join("|") + ")\\b",
          "gi"
        );

        const allowList = result.allowedSites || [];
        if (!hostnameAllowed(location.hostname, allowList)) return;

        if (document.body) {
          init();
        } else {
          document.addEventListener("DOMContentLoaded", init);
        }
      }
    );
  }

  // Test hook. Gated on a global that production never sets, so the bundle
  // behaves identically in the wild; tests.html sets it before loading.
  if (typeof window !== "undefined" && window.__WORDPOOL_TEST__) {
    window.__wordpool = {
      setDictionary(dict) {
        DICTIONARY = dict;
        const keys = Object.keys(dict);
        wordPattern = keys.length
          ? new RegExp("\\b(" + keys.join("|") + ")\\b", "gi")
          : null;
        globalCount = 0;
        sentenceCounter = 0;
        lastSwapSentence = -Infinity;
      },
      replaceInTextNode,
      trackExposure,
      flushExposures,
      showDefinitionCard,
      hideOriginalTooltip,
      setupTooltipHandlers,
      positionCard,
      resetDensity() {
        lastSwapSentence = -Infinity;
        sentenceCounter = 0;
      },
    };
    return;
  }

  start();
})();
