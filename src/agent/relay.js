// Isolated-world relay.
//
// The MAIN-world agent can see the page's fetch but cannot talk to the service worker.
// This script can do the latter but not the former. It exists solely to carry messages
// between them, and it validates everything it forwards: a page can post anything it
// likes to its own window, so this boundary is where untrusted input is filtered.

(() => {
  'use strict';

  if (window.__reconSidekickRelay) return;
  window.__reconSidekickRelay = true;

  const CHANNEL = 'recon-sidekick:observations';
  const MAX_ITEMS = 500;
  const MAX_URL_LENGTH = 2048;
  const ALLOWED_TYPES = new Set(['endpoint', 'route', 'script']);

  function sanitize(items) {
    if (!Array.isArray(items)) return [];
    const clean = [];
    for (const item of items.slice(0, MAX_ITEMS)) {
      if (!item || typeof item !== 'object') continue;
      const url = typeof item.url === 'string' ? item.url.slice(0, MAX_URL_LENGTH) : null;
      if (!url) continue;
      const type = ALLOWED_TYPES.has(item.type) ? item.type : 'endpoint';
      const method =
        typeof item.method === 'string' ? item.method.slice(0, 16).toUpperCase() : 'GET';
      // Only these three fields ever cross the boundary. Anything else the page tried
      // to attach is dropped here rather than filtered downstream.
      clean.push({ type, url, method });
    }
    return clean;
  }

  window.addEventListener('message', (event) => {
    // Only accept messages this window posted to itself.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL) return;

    const items = sanitize(data.items);
    if (!items.length) return;

    try {
      chrome.runtime.sendMessage({ type: 'observations:report', items }, () => {
        // Reading lastError suppresses the "unchecked runtime.lastError" console noise
        // that appears when the worker is asleep or the extension was just reloaded.
        void chrome.runtime.lastError;
      });
    } catch {
      // The extension context can be invalidated by a reload while the page lives on.
      // Nothing to do; the next page load will re-establish the relay.
    }
  }, { passive: true });
})();
