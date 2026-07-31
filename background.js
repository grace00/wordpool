// Relays the random "word of the day" a content script picks on each page
// load to storage, keyed by tab id, so the popup can show the word that
// belongs to whichever page is currently active — and only changes when
// that page actually reloads, not on every popup open/close.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "wordOfDay" && sender.tab && sender.tab.id != null) {
    const key = "wordOfDay_" + sender.tab.id;
    chrome.storage.session.set({ [key]: msg.payload });
  }
});

// Keep storage tidy: drop a tab's stored word once the tab itself closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("wordOfDay_" + tabId);
});
