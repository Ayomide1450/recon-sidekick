// MAIN-world page agent.
//
// Runs in the page's own JavaScript context so it can see the page's fetch and XHR.
// Registered dynamically for armed origins only (see background/programs.js).
//
// DESIGN CONSTRAINT, non-negotiable: this file must be incapable of breaking the host
// application. Every wrapper passes arguments and return values through untouched, and
// every line of our own logic is inside a try/catch that swallows failures. If this
// agent throws, the page must not notice.
//
// It records that a call happened and to where. It never reads request or response
// bodies, never reads header values, never reads cookies.

(() => {
  'use strict';

  // Guard against double injection (all_frames plus a re-registration race).
  if (window.__reconSidekickAgent) return;
  window.__reconSidekickAgent = true;

  const CHANNEL = 'recon-sidekick:observations';
  const FLUSH_MS = 1000;
  const MAX_BUFFER = 200;

  let buffer = [];
  let timer = null;

  function flush() {
    timer = null;
    if (!buffer.length) return;
    const items = buffer;
    buffer = [];
    try {
      window.postMessage({ source: CHANNEL, items }, window.location.origin);
    } catch {
      // Dropping observations is always preferable to surfacing an error in the page.
    }
  }

  function record(item) {
    try {
      if (!item || !item.url) return;
      buffer.push(item);
      // Hard cap: a page in a request loop must not grow our buffer without bound.
      if (buffer.length >= MAX_BUFFER) {
        if (timer) clearTimeout(timer);
        flush();
        return;
      }
      // Batch so a chatty SPA produces one message per second, not one per request.
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    } catch {
      // Ignore.
    }
  }

  // -------------------------------------------------------------------------
  // fetch
  // -------------------------------------------------------------------------
  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function fetch(...args) {
        try {
          const [input, init] = args;
          // `input` may be a string, a URL, or a Request. Reading `.url` off a Request
          // does not consume its body.
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input && typeof input.url === 'string'
                  ? input.url
                  : null;
          const method =
            init?.method ||
            (input && typeof input.method === 'string' ? input.method : 'GET');
          if (url) record({ type: 'endpoint', url, method });
        } catch {
          // Observation failed; the call itself must still proceed untouched.
        }
        return nativeFetch.apply(this, args);
      };
      // Preserve introspection: some apps feature-detect via fetch.toString().
      try {
        Object.defineProperty(window.fetch, 'name', { value: 'fetch' });
        window.fetch.toString = () => nativeFetch.toString();
      } catch {
        // Non-fatal.
      }
    }
  } catch {
    // Leave the native fetch in place.
  }

  // -------------------------------------------------------------------------
  // XMLHttpRequest
  // -------------------------------------------------------------------------
  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    if (typeof nativeOpen === 'function') {
      XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
        try {
          if (url) record({ type: 'endpoint', url: String(url), method: String(method || 'GET') });
        } catch {
          // Ignore.
        }
        return nativeOpen.call(this, method, url, ...rest);
      };
      try {
        XMLHttpRequest.prototype.open.toString = () => nativeOpen.toString();
      } catch {
        // Non-fatal.
      }
    }
  } catch {
    // Leave the native open in place.
  }

  // -------------------------------------------------------------------------
  // Client-side navigation
  // -------------------------------------------------------------------------
  function recordRoute() {
    try {
      record({ type: 'route', url: window.location.href });
    } catch {
      // Ignore.
    }
  }

  try {
    const nativePushState = history.pushState;
    history.pushState = function pushState(...args) {
      const result = nativePushState.apply(this, args);
      recordRoute();
      return result;
    };

    const nativeReplaceState = history.replaceState;
    history.replaceState = function replaceState(...args) {
      const result = nativeReplaceState.apply(this, args);
      recordRoute();
      return result;
    };
  } catch {
    // Leave history alone.
  }

  try {
    window.addEventListener('popstate', recordRoute, { passive: true });
    window.addEventListener('hashchange', recordRoute, { passive: true });
  } catch {
    // Ignore.
  }

  // Record the landing route, and make sure a pending batch is not lost on unload.
  recordRoute();
  try {
    window.addEventListener('pagehide', flush, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    }, { passive: true });
  } catch {
    // Ignore.
  }
})();
