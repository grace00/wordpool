(() => {
  const $ = (id) => document.getElementById(id);

  const siteToggle = $("siteToggle");
  const currentSiteNameEl = $("currentSiteName");
  const statusStateEl = $("statusState");
  const addManualBtn = $("addManual");
  const siteInput = $("siteInput");
  const learnedCountEl = $("learnedCount");
  const remainingCountEl = $("remainingCount");

  const BASE_DICTIONARY =
    typeof VOCAB_DICTIONARY !== "undefined" ? VOCAB_DICTIONARY : {};

  // Extension APIs are absent when this file is opened directly (e.g. for
  // design review), so every chrome.* path is guarded.
  const hasChrome = typeof chrome !== "undefined" && !!chrome.storage;

  // Fixed presentation state for demos and screenshots. Set to null to run
  // entirely on live storage. 168 / 504 is exactly 25% of the 672-word pool.
  // Horizontal bounds of the pool shape inside the 1490-unit viewBox. The
  // water path's curved edge sits at its local x=0, so sliding the shape to
  // POOL_X + progress * POOL_W puts the waterline at the right fraction.
  const POOL_X = 321;
  const POOL_W = 1094.8;

  let currentDomain = null;


  /* ---------------- Waterline ---------------- */

  // The waterline is generated per frame rather than played back from a fixed
  // keyframe list, so it can respond to where the cursor actually is. Two
  // components add together:
  //
  //   base   — a slow traveling sine. Exactly two periods span the height, so
  //            its mean offset is zero and the volume of water never changes.
  //   poke   — a Gaussian bump centered on the cursor's height, scaled by how
  //            close the cursor is to the waterline. It oscillates in time, so
  //            it averages out too: the water bulges and recovers rather than
  //            gaining or losing body.
  const WAVE = {
    yTop: -60,
    yBot: 660,
    steps: 26,
    baseAmp: 10, // viewBox units, ~2px on screen
    baseSpeed: 0.0019,
    pokeAmp: 42,
    pokeSigma: 115, // vertical reach of a disturbance
    pokeFreq: 1.05, // Hz — slow enough to read as a swell, not a flutter
    pokeDecay: 0.42, // seconds; the ring is done in about two swings
    reach: 240, // how near the cursor must be, horizontally, to disturb it
    retrigger: 40, // viewBox units the cursor must travel to poke again
  };

  function initWater() {
    const svg = $("poolWater");
    const path = $("waterFill");
    const canvas = document.querySelector(".pool-canvas");
    if (!svg || !path || !canvas) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      path.setAttribute("d", buildEdge(() => 0));
      return;
    }

    // A disturbance is an impulse that rings down, not a loop that runs while
    // the pointer happens to be there. One poke, one or two swings, still.
    let impulse = null; // { t0, y, amp }
    let lastPoke = null; // { x, y } of the last disturbance
    let raf = null;

    const toViewBox = (evt) => {
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      return pt.matrixTransform(ctm.inverse());
    };

    canvas.addEventListener("mousemove", (evt) => {
      const p = toViewBox(evt);
      if (!p) return;

      // Only the water's edge can be disturbed, and only from nearby.
      const dist = Math.abs(p.x - edgeX);
      if (dist > WAVE.reach) return;
      const strength = 1 - dist / WAVE.reach;

      const now = performance.now();
      const age = impulse ? (now - impulse.t0) / 1000 : Infinity;
      // Travel in either axis counts — sliding along the waterline should
      // disturb it just as much as crossing it.
      const traveled = lastPoke
        ? Math.hypot(p.x - lastPoke.x, p.y - lastPoke.y)
        : Infinity;

      // Wait for the previous ring to mostly die before allowing another.
      if (age > WAVE.pokeDecay * 1.6 && traveled > WAVE.retrigger) {
        impulse = { t0: now, y: p.y, amp: strength };
        lastPoke = { x: p.x, y: p.y };
      }
    });

    canvas.addEventListener("mouseleave", () => {
      lastPoke = null;
    });

    const frame = (t) => {
      let ring = 0;
      let ringY = 0;
      if (impulse) {
        const age = (t - impulse.t0) / 1000;
        if (age > WAVE.pokeDecay * 6) {
          impulse = null;
        } else {
          // Damped oscillator: exp decay envelope on a slow sine.
          ring =
            impulse.amp *
            Math.exp(-age / WAVE.pokeDecay) *
            Math.sin(2 * Math.PI * WAVE.pokeFreq * age);
          ringY = impulse.y;
        }
      }

      path.setAttribute(
        "d",
        buildEdge((y) => {
          const span = WAVE.yBot - WAVE.yTop;
          const phase = ((y - WAVE.yTop) / span) * 2 * Math.PI * 2;
          let x = WAVE.baseAmp * Math.sin(phase + t * WAVE.baseSpeed);
          if (ring !== 0) {
            const dy = y - ringY;
            const falloff = Math.exp(
              -(dy * dy) / (2 * WAVE.pokeSigma * WAVE.pokeSigma)
            );
            x += WAVE.pokeAmp * ring * falloff;
          }
          return x;
        })
      );
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
      } else if (!raf) {
        raf = requestAnimationFrame(frame);
      }
    });
  }

  // Samples offsetAt(y) down the height and joins the points with midpoint
  // quadratics, which smooths the polyline without needing spline maths.
  function buildEdge(offsetAt) {
    const { yTop, yBot, steps } = WAVE;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const y = yTop + ((yBot - yTop) * i) / steps;
      pts.push([offsetAt(y), y]);
    }
    let d = `M -1400 ${yTop} L ${pts[0][0].toFixed(1)} ${yTop}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      d += ` Q ${x0.toFixed(1)} ${y0.toFixed(1)} ${((x0 + x1) / 2).toFixed(1)} ${((y0 + y1) / 2).toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${last[0].toFixed(1)} ${yBot} L -1400 ${yBot} Z`;
    return d;
  }

  // Where the waterline currently sits, in viewBox units.
  let edgeX = POOL_X;
  function currentEdgeX() {
    return edgeX;
  }

  /* ---------------- Pool + metrics ---------------- */

  function setPoolProgress(progress) {
    const p = Math.max(0, Math.min(1, progress));
    // The group holds position; the path inside holds the ripple animation.
    edgeX = POOL_X + p * POOL_W;
    const water = $("waterShift");
    if (water) water.style.transform = `translateX(${edgeX}px)`;
  }

  function updatePoolVisualization(learned, remaining) {
    learnedCountEl.textContent = learned;
    remainingCountEl.textContent = remaining;
    const total = learned + remaining;
    const progress = total > 0 ? learned / total : 0;
    setPoolProgress(progress);

    // Each label occupies the same share of the width as its portion of the
    // water, so it sits under the region it describes. A floor keeps the
    // smaller label readable when progress is near either extreme.
    const learnedLink = $("learnedLink");
    const remainingLink = $("remainingLink");
    if (learnedLink && remainingLink) {
      const share = Math.min(0.82, Math.max(0.18, progress));
      learnedLink.style.flex = share + " 1 0";
      remainingLink.style.flex = 1 - share + " 1 0";
      learnedLink.setAttribute("aria-label", "View " + learned + " learned words");
      remainingLink.setAttribute("aria-label", "View " + remaining + " remaining words");
    }
  }

  function renderWordCount() {
    if (!hasChrome) return;
    chrome.storage.sync.get(
      { disabledTriggers: [], customWords: {}, learnedWords: [] },
      (res) => {
        const learnedSet = new Set(res.learnedWords || []);
        const disabled = new Set(res.disabledTriggers || []);
        const custom = res.customWords || {};

        // The pool is your whole vocabulary list, so these counts span the
        // entire dictionary. The difficulty tier decides only which words get
        // swapped while browsing — it does not shrink the pool, and scoping
        // these numbers to it made the popup disagree with the pool page.
        // Words retired by hand are in neither count: they are out of
        // rotation, not progress.
        let learned = 0;
        let remaining = 0;
        const tally = (trig) => {
          // Learned words are also stored as disabled, so check learned first
          // or they would fall out of both counts.
          if (learnedSet.has(trig)) learned++;
          else if (!disabled.has(trig)) remaining++;
        };

        Object.keys(BASE_DICTIONARY).forEach(tally);
        Object.keys(custom).forEach(tally);

        updatePoolVisualization(learned, remaining);
      }
    );
  }

  /* ---------------- Site toggle ---------------- */

  // Shared with the Active sites page so both reject internal URLs the same
  // way; see shared.js.
  const normalizeDomain = window.WordpoolShared.normalizeDomain;

  function getSites(cb) {
    if (!hasChrome) return cb([]);
    chrome.storage.sync.get({ allowedSites: [] }, (res) => {
      const { kept, changed } = window.WordpoolShared.migrateSites(res.allowedSites);
      if (changed) chrome.storage.sync.set({ allowedSites: kept });
      cb(kept);
    });
  }

  function setSites(sites, cb) {
    if (!hasChrome) return cb && cb();
    chrome.storage.sync.set({ allowedSites: sites }, cb);
  }

  // Extension, browser-internal and blank pages have no meaningful hostname;
  // showing a raw chrome-extension:// URL there reads like a bug.
  function friendlySiteName(url) {
    if (!url) return null;
    if (/^chrome-extension:|^moz-extension:/.test(url)) return "extension pages";
    if (/^(chrome|edge|about|brave|opera):/.test(url)) return "browser pages";
    if (/^file:/.test(url)) return "local files";
    return normalizeDomain(url);
  }

  function renderSiteStatus(active, siteLabel) {
    const row = document.querySelector(".toggle-row");
    if (row) row.classList.toggle("is-inactive", !active);
    if (statusStateEl) statusStateEl.textContent = active ? "Active" : "Inactive";
    if (currentSiteNameEl) {
      currentSiteNameEl.textContent = active
        ? "on " + siteLabel
        : "on " + siteLabel;
    }
  }

  function initCurrentSite() {
    if (!hasChrome || !chrome.tabs) {
      // No tab context — fall back to the demo hostname.
      siteToggle.checked = false;
      siteToggle.disabled = true;
      renderSiteStatus(false, "this site");
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const url = tab && tab.url;
      const label = friendlySiteName(url);
      // Only real http(s) hosts can be toggled on or off.
      const domain = url && /^https?:/.test(url) ? normalizeDomain(url) : null;
      currentDomain = domain;
      const shown = label || "this site";

      if (!domain) {
        // Internal pages can't be toggled on or off.
        siteToggle.checked = false;
        siteToggle.disabled = true;
        renderSiteStatus(siteToggle.checked, shown);
        return;
      }
      getSites((sites) => {
        siteToggle.checked = sites.includes(domain);
        renderSiteStatus(siteToggle.checked, shown);
      });
    });
  }

  siteToggle.addEventListener("change", () => {
    renderSiteStatus(
      siteToggle.checked,
      (currentSiteNameEl.textContent || "").replace(/^on /, "")
    );
    if (!currentDomain) return;
    getSites((sites) => {
      const has = sites.includes(currentDomain);
      if (siteToggle.checked && !has) {
        setSites([...sites, currentDomain]);
      } else if (!siteToggle.checked && has) {
        setSites(sites.filter((s) => s !== currentDomain));
      }
    });
  });

  const addSiteMsg = $("addSiteMsg");
  let addResetTimer = null;

  // Every outcome is announced in words as well as color, so the state is
  // legible without relying on hue alone.
  function setAddMessage(text, state) {
    if (!addSiteMsg) return;
    addSiteMsg.textContent = text;
    if (state) addSiteMsg.dataset.state = state;
    else delete addSiteMsg.dataset.state;
  }

  function flashAdded(domain) {
    setAddMessage(domain + " added", "success");
    addManualBtn.textContent = "Added ✓";
    addManualBtn.classList.add("is-added");
    clearTimeout(addResetTimer);
    addResetTimer = setTimeout(() => {
      addManualBtn.textContent = "Add";
      addManualBtn.classList.remove("is-added");
      setAddMessage("", null);
    }, 1800);
  }

  addManualBtn.addEventListener("click", () => {
    const raw = siteInput.value.trim();
    if (!raw) {
      setAddMessage("Enter a valid domain", "error");
      siteInput.focus();
      return;
    }
    const domain = normalizeDomain(raw);
    if (!domain || !domain.includes(".")) {
      setAddMessage("Enter a valid domain", "error");
      siteInput.focus();
      return;
    }

    getSites((sites) => {
      if (sites.includes(domain)) {
        setAddMessage("Already added", "error");
        return;
      }
      try {
        setSites([...sites, domain], () => {
          // chrome.runtime.lastError surfaces quota and sync failures that
          // otherwise fail silently.
          if (hasChrome && chrome.runtime && chrome.runtime.lastError) {
            setAddMessage("Couldn't add site", "error");
            return;
          }
          siteInput.value = "";
          if (domain === currentDomain) siteToggle.checked = true;
          flashAdded(domain);
        });
      } catch (e) {
        setAddMessage("Couldn't add site", "error");
      }
    });
  });

  siteInput.addEventListener("input", () => {
    if (addSiteMsg && addSiteMsg.dataset.state === "error") setAddMessage("", null);
  });

  siteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addManualBtn.click();
  });

  /* ---------------- Word of the day ---------------- */

  // The content script picks one random word per page load and reports it to
  // the background worker, keyed by tab id, so it only changes when the page
  // reloads — not when the popup is reopened.
  // The section has exactly three states — loading, available, unavailable —
  // and always lands in one of them. It used to bail out early whenever no
  // word was stored for the tab, which left the placeholder on screen and
  // looked like the section had vanished. That happens routinely: on pages
  // where content scripts can't run, in tabs opened before the extension was
  // loaded, after a browser restart (session storage is cleared), and while
  // swapping is paused.
  function setWordOfDay(state, word, def) {
    const section = $("wordOfDay");
    const titleEl = $("wordTitle");
    const defEl = $("wordDef");
    if (!section || !titleEl || !defEl) return;
    section.dataset.state = state;
    titleEl.textContent = word;
    defEl.textContent = def || "";
  }

  // Falls back to the bundled dictionary so the popup never depends on a
  // content script having run. The pick is cached for the session so it stays
  // put while the popup is opened and closed.
  function pickFallbackWord(cb) {
    const keys = Object.keys(BASE_DICTIONARY);
    if (keys.length === 0) return cb(null);
    const choose = () => {
      const trigger = keys[Math.floor(Math.random() * keys.length)];
      const e = BASE_DICTIONARY[trigger];
      return e && e.word ? { word: e.word, def: e.def } : null;
    };
    if (!hasChrome || !chrome.storage.session) return cb(choose());
    chrome.storage.session.get(["wordOfDayFallback"], (res) => {
      const cached = res && res.wordOfDayFallback;
      if (cached && cached.word) return cb(cached);
      const picked = choose();
      if (picked) chrome.storage.session.set({ wordOfDayFallback: picked });
      cb(picked);
    });
  }

  function showFallbackOrUnavailable() {
    pickFallbackWord((picked) => {
      if (picked) setWordOfDay("available", picked.word, picked.def);
      else setWordOfDay("unavailable", "No word available", "Your word list is empty — add or re-enable words from the pool.");
    });
  }

  function renderWordOfDay() {
    setWordOfDay("loading", "Loading…", "");

    if (!hasChrome || !chrome.tabs || !chrome.storage.session) {
      showFallbackOrUnavailable();
      return;
    }

    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    // Storage callbacks can hang if the service worker is starting up; the
    // section must not sit on "Loading…" indefinitely.
    const timeout = setTimeout(() => settle(showFallbackOrUnavailable), 1200);

    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || tab.id == null) {
          clearTimeout(timeout);
          return settle(showFallbackOrUnavailable);
        }
        const key = "wordOfDay_" + tab.id;
        chrome.storage.session.get([key], (res) => {
          clearTimeout(timeout);
          const data = res && res[key];
          settle(() => {
            if (data && data.word) setWordOfDay("available", data.word, data.def);
            else showFallbackOrUnavailable();
          });
        });
      });
    } catch (e) {
      clearTimeout(timeout);
      settle(showFallbackOrUnavailable);
    }
  }

  /* ---------------- Overflow menu ---------------- */

  function initOverflowMenu() {
    const wrap = $("overflow");
    const btn = $("overflowBtn");
    const menu = $("overflowMenu");
    const pauseItem = $("pauseItem");

    const setOpen = (open) => {
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector(".menu-item").focus();
    };

    const setPauseLabel = (paused) => {
      pauseItem.textContent = paused ? "Resume everywhere" : "Pause everywhere";
    };

    if (hasChrome) {
      chrome.storage.sync.get({ paused: false }, (res) => setPauseLabel(res.paused));
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(menu.hidden);
    });

    document.addEventListener("click", (e) => {
      if (!menu.hidden && !wrap.contains(e.target)) setOpen(false);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) {
        setOpen(false);
        btn.focus();
      }
    });

    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll(".menu-item")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        items[(i + 1) % items.length].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        items[(i - 1 + items.length) % items.length].focus();
      }
    });

    menu.addEventListener("click", (e) => {
      const item = e.target.closest(".menu-item");
      if (!item) return;
      const action = item.dataset.action;
      if (!hasChrome) return setOpen(false);

      if (action === "settings") {
        chrome.tabs.create({ url: chrome.runtime.getURL("words.html") });
      } else if (action === "help") {
        chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
      } else if (action === "pause") {
        chrome.storage.sync.get({ paused: false }, (res) => {
          const next = !res.paused;
          chrome.storage.sync.set({ paused: next }, () => setPauseLabel(next));
        });
      }
      setOpen(false);
    });
  }

  // Clicking the water opens the learned words; clicking the pale remainder
  // opens what's still to learn. Both are keyboard-operable.
  function initPoolLinks() {
    const canvas = document.querySelector(".pool-canvas");
    const hint = $("poolHint");

    const open = (filter) => {
      const url = "words.html?filter=" + filter;
      if (hasChrome && chrome.tabs) {
        chrome.tabs.create({ url: chrome.runtime.getURL(url) });
      } else {
        window.open(url, "_blank", "noopener");
      }
    };

    const REGIONS = {
      learned: {
        filter: "learned",
        hot: "hot-learned",
        label: () => "View " + learnedCountEl.textContent + " learned words",
      },
      remaining: {
        filter: "learning",
        hot: "hot-remaining",
        label: () => "View " + remainingCountEl.textContent + " remaining words",
      },
    };

    // Keeps the chip just above-right of the pointer, clamped inside the
    // canvas so it never hangs off an edge.
    const placeHint = (evt) => {
      if (!hint || !canvas) return;
      const box = canvas.getBoundingClientRect();
      const w = hint.offsetWidth;
      const h = hint.offsetHeight;
      let x = evt.clientX - box.left + 12;
      let y = evt.clientY - box.top - h - 8;
      x = Math.max(2, Math.min(x, box.width - w - 2));
      if (y < 2) y = evt.clientY - box.top + 14;
      hint.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };

    const enter = (key, evt) => {
      const r = REGIONS[key];
      if (canvas) canvas.classList.add(r.hot);
      if (hint) {
        hint.textContent = r.label();
        hint.classList.add("is-visible");
        if (evt && evt.clientX != null) placeHint(evt);
      }
    };

    const leave = (key) => {
      if (canvas) canvas.classList.remove(REGIONS[key].hot);
      if (hint) hint.classList.remove("is-visible");
    };

    // The pool region and its legend label are two handles on the same thing,
    // so they light up and navigate together.
    const wire = (el, key) => {
      if (!el) return;
      const r = REGIONS[key];
      el.addEventListener("mouseenter", (e) => enter(key, e));
      el.addEventListener("mousemove", placeHint);
      el.addEventListener("mouseleave", () => leave(key));
      el.addEventListener("focus", () => enter(key));
      el.addEventListener("blur", () => leave(key));
      el.addEventListener("click", () => open(r.filter));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(r.filter);
        }
      });
    };

    wire($("waterFill"), "learned");
    wire($("learnedLink"), "learned");
    wire($("poolEmpty"), "remaining");
    wire($("remainingLink"), "remaining");
  }

  initCurrentSite();
  initPoolLinks();
  initWater();
  renderWordCount();
  renderWordOfDay();
  initOverflowMenu();
})();
