// Normalization of observed URLs into stable endpoint identities.
//
// This is load-bearing: if /api/users/8821 and /api/users/9910 do not collapse to the
// same identity, the timeline fills with thousands of near-duplicate "new endpoint"
// rows and the product is worthless.
//
// Pure functions only. No chrome.* access. Unit tested in test/normalize.test.js.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{12,}$/i;
const NUMERIC = /^\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const B64ISH = /^[A-Za-z0-9_-]{24,}={0,2}$/;
const JWTISH = /^ey[A-Za-z0-9_-]{8,}$/;

// A segment that mixes letters and a long digit run is usually an id with a prefix,
// e.g. "user_8821", "ORD-00014922".
const PREFIXED_ID = /^[A-Za-z][A-Za-z_-]{0,12}[-_]?\d{4,}$/;

/**
 * Collapse a single path segment to a placeholder if it looks like an identifier.
 * Returns the original segment when it looks like a stable route name.
 */
export function normalizeSegment(segment) {
  if (!segment) return segment;
  if (NUMERIC.test(segment)) return '{id}';
  if (UUID.test(segment)) return '{uuid}';
  if (DATE.test(segment)) return '{date}';
  if (JWTISH.test(segment)) return '{token}';
  if (HEX.test(segment)) return '{hash}';
  if (PREFIXED_ID.test(segment)) return '{id}';
  // Check b64ish last: it is the broadest pattern and would otherwise swallow
  // legitimately long route names.
  if (B64ISH.test(segment) && /\d/.test(segment)) return '{b64}';
  return segment;
}

/**
 * Normalize a pathname: collapse identifier-like segments, strip the trailing slash.
 */
export function normalizePath(pathname) {
  if (!pathname || pathname === '/') return '/';
  const normalized = pathname
    .split('/')
    .map(normalizeSegment)
    .join('/');
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
}

/**
 * Extract sorted parameter NAMES from a query string. Values are deliberately
 * discarded and never stored — see the privacy invariants in the design doc.
 */
export function paramNames(search) {
  if (!search) return [];
  const qs = search.startsWith('?') ? search.slice(1) : search;
  if (!qs) return [];
  const names = new Set();
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const name = pair.split('=')[0];
    if (name) names.add(decodeURIComponent(name));
  }
  return [...names].sort();
}

/**
 * Turn an observed request URL into a stable endpoint identity.
 *
 * Returns null for URLs we never want to record (non-http schemes, data/blob URLs).
 * Returns { value, raw, host, method } where `value` is the deduplication key.
 */
export function normalizeEndpoint(rawUrl, { method = 'GET', base } = {}) {
  let url;
  try {
    url = new URL(rawUrl, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  const path = normalizePath(url.pathname);
  const params = paramNames(url.search);
  const verb = String(method || 'GET').toUpperCase();

  let value = `${verb} ${host}${path}`;
  if (params.length) value += `?${params.join('&')}`;

  return {
    value,
    // One raw example is retained per endpoint so an over-aggressive collapse stays
    // visible and recoverable. Query values are stripped from the example too.
    raw: `${url.origin}${url.pathname}`,
    host,
    path,
    method: verb,
    params,
  };
}

/**
 * Normalize a client-side route (from pushState / popstate or a mined route table).
 * Routes have no method and no host-level identity for dedup purposes.
 */
export function normalizeRoute(rawUrl, { base } = {}) {
  let path;
  let origin = '';
  try {
    const url = new URL(rawUrl, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    path = url.pathname;
    origin = url.origin;
  } catch {
    // Mined route patterns are often bare paths like "/admin/:id" with no origin.
    if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) return null;
    path = rawUrl;
  }

  // Mined route patterns already use :param / * placeholders. Unify them with the
  // placeholders normalizeSegment produces so a mined route and a visited route
  // compare equal — this is what makes the "unreached" diff actually work.
  const unified = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '{id}';
      if (segment === '*' || segment === '**') return '{splat}';
      if (/^\[.+\]$/.test(segment)) return '{id}'; // Next.js [slug]
      if (/^\{.+\}$/.test(segment)) return '{id}'; // already a placeholder
      return normalizeSegment(segment);
    })
    .join('/');

  const value = unified.length > 1 && unified.endsWith('/')
    ? unified.slice(0, -1)
    : unified;

  return { value, raw: origin ? origin + path : path, path: value };
}
