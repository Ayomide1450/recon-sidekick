// Scope matching. Pure functions — the storage side lives in background/programs.js.
//
// Nothing is recorded for a host that does not match an armed program. This is the
// single most important gate in the extension: it is what keeps the user's banking and
// email out of a local database of endpoint shapes.

/**
 * Match a hostname against one pattern.
 *
 * Supported forms:
 *   target.com      exact host only
 *   *.target.com    any subdomain, and the apex itself
 *   .target.com     same as *.target.com
 */
export function hostMatchesPattern(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  let pat = pattern.toLowerCase().trim().replace(/\.$/, '');
  if (!pat) return false;

  if (pat.startsWith('*.')) pat = pat.slice(1); // "*.x.com" -> ".x.com"

  if (pat.startsWith('.')) {
    const apex = pat.slice(1);
    return host === apex || host.endsWith(pat);
  }

  return host === pat;
}

/**
 * Find the armed program covering a hostname, or null.
 */
export function programForHost(hostname, programs) {
  if (!hostname || !Array.isArray(programs)) return null;
  for (const program of programs) {
    if (!program?.enabled) continue;
    for (const pattern of program.hosts || []) {
      if (hostMatchesPattern(hostname, pattern)) return program;
    }
  }
  return null;
}

/**
 * Find the armed program covering a URL, or null. Non-http URLs never match.
 */
export function programForUrl(url, programs) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return programForHost(parsed.hostname, programs);
  } catch {
    return null;
  }
}

/**
 * Translate a host pattern into the Chrome match patterns needed for permissions and
 * dynamic content script registration.
 */
export function toMatchPatterns(pattern) {
  let pat = pattern.toLowerCase().trim().replace(/\.$/, '');
  if (!pat) return [];
  if (pat.startsWith('*.')) pat = pat.slice(1);

  if (pat.startsWith('.')) {
    const apex = pat.slice(1);
    return [`*://${apex}/*`, `*://*.${apex}/*`];
  }
  return [`*://${pat}/*`];
}

/** Validate a user-entered host pattern. Returns an error string, or null if valid. */
export function validateHostPattern(pattern) {
  const pat = String(pattern || '').trim();
  if (!pat) return 'Host cannot be empty';
  if (pat.includes('://')) return 'Enter a host, not a URL (e.g. *.target.com)';
  if (pat.includes('/')) return 'Enter a host, not a path';
  if (pat.includes(' ')) return 'Host cannot contain spaces';
  const bare = pat.replace(/^\*\./, '').replace(/^\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(bare)) {
    return 'Not a valid hostname';
  }
  // Refuse patterns broad enough to vacuum up unrelated browsing.
  if (/^\.?(?:com|net|org|io|dev|co|app|ai)$/i.test(bare)) return 'Pattern is too broad';
  return null;
}
