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

  function trackExposure(trigger) {
    chrome.storage.sync.get(
      {
        autoMark: false,
        autoMarkThreshold: 10,
        exposureCounts: {},
        learnedWords: [],
        disabledTriggers: [],
      },
      (res) => {
        if (!res.autoMark) return;

        const counts = res.exposureCounts || {};
        counts[trigger] = (counts[trigger] || 0) + 1;

        const threshold = Math.max(1, res.autoMarkThreshold || 10);
        if (counts[trigger] >= threshold) {
          // Auto-mark as learned
          const learned = res.learnedWords || [];
          const disabled = res.disabledTriggers || [];
          if (!learned.includes(trigger)) {
            learned.push(trigger);
          }
          if (!disabled.includes(trigger)) {
            disabled.push(trigger);
          }
          chrome.storage.sync.set({
            exposureCounts: counts,
            learnedWords: learned,
            disabledTriggers: disabled,
          });

          // Remove from this page's dictionary
          delete DICTIONARY[trigger];
          const remainingKeys = Object.keys(DICTIONARY);
          wordPattern =
            remainingKeys.length > 0
              ? new RegExp("\\b(" + remainingKeys.join("|") + ")\\b", "gi")
              : null;
        } else {
          chrome.storage.sync.set({ exposureCounts: counts });
        }
      }
    );
  }

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
    chrome.storage.sync.get({ learnedWords: [], disabledTriggers: [] }, (res) => {
      const learned = res.learnedWords || [];
      if (!learned.includes(trigger)) {
        chrome.storage.sync.set({ learnedWords: [...learned, trigger] });
      }
      const disabled = res.disabledTriggers || [];
      if (!disabled.includes(trigger)) {
        chrome.storage.sync.set({ disabledTriggers: [...disabled, trigger] });
      }
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
    chrome.storage.sync.get({ disabledTriggers: [] }, (result) => {
      const disabled = result.disabledTriggers || [];
      if (!disabled.includes(trigger)) {
        chrome.storage.sync.set({ disabledTriggers: [...disabled, trigger] });
      }
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
        // Swapping the text in place reflows the sentence — the original is
        // rarely the same width as the swap. Instead keep the swapped text
        // in flow (just invisible) and paint the original over it in an
        // absolutely positioned overlay, so nothing around it moves at all.
        const color = getComputedStyle(span).color;
        // An absolutely positioned box inside an inline element is anchored
        // to that inline's content area, but the overlay's own line box adds
        // half-leading on top, which drops the text a couple of pixels. A
        // line-height matching the content area gets close; the exact
        // remainder is measured and corrected below.
        const box = span.getClientRects()[0];
        const lineHeight = box ? box.height : null;
        // Rect of the swapped text as it sits now. It stays valid after the
        // overlay is added, since an absolute box doesn't reflow the line.
        const swappedTextNode = span.firstChild;
        const baseRect = textRect(swappedTextNode);
        span.dataset.revealed = "1";
        span.style.position = "relative";
        span.style.color = "transparent";
        span.title = "Click for full definition";

        const overlay = document.createElement("span");
        overlay.className = "vocab-reveal-ext";
        overlay.textContent = span.dataset.original;
        Object.assign(overlay.style, {
          position: "absolute",
          left: "0",
          top: "0",
          color: color,
          whiteSpace: "nowrap",
          pointerEvents: "none",
          lineHeight: lineHeight ? lineHeight + "px" : "normal",
        });
        span.appendChild(overlay);

        // Both rects come from the same font metrics, so once the overlay's
        // text box lines up with the swapped one they share a baseline.
        // Correcting the measured delta absorbs any sub-pixel rounding.
        const overlayRect = textRect(overlay.firstChild);
        if (baseRect && overlayRect) {
          const dy = overlayRect.top - baseRect.top;
          const dx = overlayRect.left - baseRect.left;
          if (dy) overlay.style.top = -dy + "px";
          if (dx) overlay.style.left = -dx + "px";
        }

        const restore = () => {
          overlay.remove();
          span.style.position = "";
          span.style.color = "";
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
