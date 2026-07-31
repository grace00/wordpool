(() => {
  const listEl = document.getElementById("list");
  const emptyStateEl = document.getElementById("emptyState");
  const countLabel = document.getElementById("countLabel");
  const siteInput = document.getElementById("siteInput");
  const addSiteBtn = document.getElementById("addSite");
  const msgEl = document.getElementById("siteMsg");

  const { normalizeDomain, migrateSites } = window.WordpoolShared;
  const hasChrome = typeof chrome !== "undefined" && !!chrome.storage;

  let resetTimer = null;

  function getSites(cb) {
    if (!hasChrome) return cb([]);
    chrome.storage.sync.get({ allowedSites: [] }, (res) => cb(res.allowedSites));
  }

  function setSites(sites, cb) {
    if (!hasChrome) return cb && cb();
    chrome.storage.sync.set({ allowedSites: sites }, cb);
  }

  // Both wording and color carry the outcome, so state is never signaled
  // by hue alone.
  function setMessage(text, state) {
    msgEl.textContent = text;
    if (state) msgEl.dataset.state = state;
    else delete msgEl.dataset.state;
  }

  function flashAdded(domain) {
    setMessage(domain + " added", "success");
    addSiteBtn.textContent = "Added ✓";
    addSiteBtn.classList.add("is-added");
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      addSiteBtn.textContent = "Add";
      addSiteBtn.classList.remove("is-added");
      setMessage("", null);
    }, 1800);
  }

  function render() {
    getSites((sites) => {
      const sorted = sites.slice().sort();
      countLabel.textContent = String(sorted.length);
      listEl.innerHTML = "";
      emptyStateEl.hidden = sorted.length > 0;
      listEl.hidden = sorted.length === 0;

      sorted.forEach((site) => {
        const row = document.createElement("div");
        row.className = "word-row";

        const text = document.createElement("div");
        text.className = "word-text";
        text.textContent = site;
        row.appendChild(text);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "word-delete";
        del.textContent = "×";
        del.setAttribute("aria-label", "Remove " + site);
        del.title = "Remove " + site;
        del.addEventListener("click", () => {
          getSites((current) =>
            setSites(current.filter((s) => s !== site), render)
          );
        });
        row.appendChild(del);

        listEl.appendChild(row);
      });
    });
  }

  function addSite() {
    const raw = siteInput.value.trim();
    if (!raw) {
      setMessage("Enter a valid domain", "error");
      siteInput.focus();
      return;
    }
    const domain = normalizeDomain(raw);
    if (!domain) {
      setMessage("Enter a valid domain", "error");
      siteInput.focus();
      return;
    }

    getSites((sites) => {
      if (sites.includes(domain)) {
        setMessage("Already added", "error");
        return;
      }
      try {
        setSites([...sites, domain], () => {
          if (hasChrome && chrome.runtime && chrome.runtime.lastError) {
            setMessage("Couldn't add site", "error");
            return;
          }
          siteInput.value = "";
          flashAdded(domain);
          render();
        });
      } catch (e) {
        setMessage("Couldn't add site", "error");
      }
    });
  }

  addSiteBtn.addEventListener("click", addSite);

  siteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSite();
  });

  siteInput.addEventListener("input", () => {
    if (msgEl.dataset.state === "error") setMessage("", null);
  });

  // Lists saved before internal URLs were rejected can contain entries like
  // "chrome", produced by coercing chrome://extensions into a hostname.
  // Drop those once, on load, leaving every real domain in place.
  function migrateThenRender() {
    getSites((sites) => {
      const { kept, removed, changed } = migrateSites(sites);
      if (!changed) return render();
      setSites(kept, () => {
        if (removed.length) {
          setMessage(
            "Removed " +
              removed.length +
              (removed.length === 1 ? " entry" : " entries") +
              " that aren't websites: " +
              removed.join(", "),
            null
          );
        }
        render();
      });
    });
  }

  migrateThenRender();
})();
