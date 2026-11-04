// The mining rule pack and noise filters.
//
// v1 deliberately uses pattern mining rather than AST parsing (see the design doc).
// That trades precision for breadth, which means the noise filters here are as
// important as the extraction patterns: every false positive costs the user a keystroke
// in the Unreached view.
//
// Pure data and pure functions. Unit tested in test/mine.test.js.

// Extensions that are assets, never endpoints.
export const ASSET_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'map',
  'css', 'scss', 'less',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'mp4', 'webm', 'mp3', 'wav', 'ogg',
  'pdf', 'zip', 'gz', 'br',
  'html', 'htm', 'txt', 'xml',
]);

// Path prefixes that are overwhelmingly static asset trees.
const ASSET_PREFIXES = [
  '/static/', '/assets/', '/_next/static/', '/dist/', '/build/',
  '/images/', '/img/', '/fonts/', '/media/', '/css/', '/js/',
];

// Segments that indicate an i18n key or a CSS/template fragment rather than a path.
const I18N_HINTS = /\.(?:label|title|description|placeholder|error|message|button|heading|tooltip|subtitle)$/i;

/**
 * Path-like string literals. Deliberately anchored on a leading slash: unanchored
 * matching produces far more noise than it recovers in signal.
 */
export const PATH_PATTERN =
  /["'`](\/(?:[A-Za-z0-9_\-.~{}:*[\]$]+\/?)+)["'`]/g;

/** GraphQL operation declarations. */
export const GQL_PATTERN =
  /\b(?:query|mutation|subscription)\s+([A-Z][A-Za-z0-9_]{2,60})\s*[({@]/g;

/**
 * Feature-flag-ish identifiers: dotted or snake-cased namespaces in string literals.
 * Requires at least one separator so bare words do not match.
 */
export const FLAG_PATTERN =
  /["'`]([a-z][a-z0-9]*(?:[._-][a-z0-9]+){1,4})["'`]/g;

/**
 * Paths that look like a server API rather than a page the user navigates to.
 *
 * Everything else path-shaped is a client route. Defaulting to "route" matters: most
 * paths in a bundle are pages, and the original default of "endpoint" mislabelled whole
 * admin sections, which made the route filter useless.
 */
export const ENDPOINT_HINT =
  /^\/(?:api|graphql|gql|rest|rpc|_api|_next\/data|ajax|xhr|service|services|internal|v\d+|wp-json|\.well-known)(?:\/|$)/i;

/**
 * Classify a mined path. Returns 'endpoint' or 'route'.
 *
 * A trailing `.json`/`.xml` also reads as an API even without an /api prefix.
 */
export function classifyPath(path) {
  if (ENDPOINT_HINT.test(path)) return 'endpoint';
  if (/\.(?:json|xml)$/i.test(path)) return 'endpoint';
  return 'route';
}

/** Role and permission constants. */
export const ROLE_PATTERN =
  /["'`((](ROLE_[A-Z][A-Z0-9_]{2,40}|(?:is|can|has)_?[A-Za-z]*(?:[Aa]dmin|[Oo]wner|[Ss]uperuser|[Mm]oderator|[Ss]taff|[Ss]udo)[A-Za-z_]*|[a-z_]*(?:admin|superuser|moderator|impersonat)[a-z_]*)["'`),]/g;

/** Terms that make an unreached path worth looking at first. */
const INTEREST_TERMS = new Map([
  ['impersonat', 5],
  ['internal', 4],
  ['admin', 4],
  ['superuser', 4],
  ['debug', 4],
  ['actuator', 4],
  ['swagger', 3],
  ['openapi', 3],
  ['graphql', 3],
  ['export', 3],
  ['import', 2],
  ['backup', 3],
  ['restore', 3],
  ['refund', 3],
  ['billing', 2],
  ['invoice', 2],
  ['webhook', 2],
  ['invite', 2],
  ['token', 2],
  ['secret', 3],
  ['config', 2],
  ['setting', 1],
  ['delete', 2],
  ['purge', 2],
  ['sudo', 3],
  ['root', 2],
  ['upload', 2],
  ['proxy', 2],
  ['redirect', 2],
  ['callback', 1],
  ['oauth', 2],
  ['sso', 2],
  ['reset', 2],
  ['verify', 1],
]);

/**
 * True when a mined path string should be discarded before it ever reaches storage.
 */
export function isNoise(path) {
  if (typeof path !== 'string') return true;
  if (path.length < 2 || path.length > 160) return true;
  if (!path.startsWith('/')) return true;
  if (path.startsWith('//')) return true; // protocol-relative URL
  if (path.includes('://')) return true;
  if (path.includes(' ')) return true;
  if (path.includes('\\')) return true;

  // A path made only of placeholders carries no information.
  if (/^[/{}:*\][\d]+$/.test(path)) return true;

  const lower = path.toLowerCase();

  for (const prefix of ASSET_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }

  const lastSegment = lower.split('/').pop() || '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot > 0) {
    const ext = lastSegment.slice(dot + 1);
    if (ASSET_EXTENSIONS.has(ext)) return true;
  }

  if (I18N_HINTS.test(path)) return true;

  // Single-character segments are almost always minifier artifacts.
  if (path.split('/').some((s) => s.length === 1 && /[a-z]/i.test(s))) return true;

  return false;
}

/** Flag candidates need tighter filtering than paths — the pattern is broad. */
export function isFlagNoise(value) {
  if (typeof value !== 'string') return true;
  if (value.length < 5 || value.length > 80) return true;
  if (value.startsWith('.') || value.endsWith('.')) return true;

  const lower = value.toLowerCase();

  // Filenames, mime types, versions, and CSS properties dominate the false positives.
  const lastPart = lower.split('.').pop() || '';
  if (ASSET_EXTENSIONS.has(lastPart)) return true;
  if (/^\d+(\.\d+)+$/.test(value)) return true; // version string
  if (I18N_HINTS.test(value)) return true;
  if (/^(?:text|image|application|audio|video|font|multipart)\//.test(lower)) return true;
  if (/^-{1,2}/.test(value)) return true; // CSS custom property
  if (/^(?:utf|iso|windows)-/.test(lower)) return true;

  // Require a flag-ish shape: a namespace separated by dots or underscores.
  return !/^[a-z][a-z0-9]*(?:[._][a-z0-9]+){1,4}$/.test(lower);
}

/**
 * Generic role words that carry no signal on their own. "admin" matches half the
 * strings in a typical bundle; "is_admin" is an actual permission check.
 */
const BARE_ROLE_WORDS = new Set([
  'admin', 'admins', 'user', 'users', 'owner', 'owners', 'staff', 'member', 'members',
  'moderator', 'moderators', 'role', 'roles', 'guest', 'guests', 'manager', 'managers',
  'permission', 'permissions', 'group', 'groups',
]);

/** A role candidate needs more shape than a single generic word. */
export function isRoleNoise(value) {
  if (typeof value !== 'string') return true;
  if (value.length < 4 || value.length > 48) return true;
  const lower = value.toLowerCase();
  if (BARE_ROLE_WORDS.has(lower)) return true;
  // Keep anything with structure: ROLE_X, is_admin, isAdmin, org_owner.
  if (/^ROLE_/.test(value)) return false;
  if (value.includes('_')) return false;
  if (/[a-z][A-Z]/.test(value)) return false;
  // A bare single word survives only if it is not a generic one.
  return false;
}

/**
 * Crude, honest interest score, with the reasons that produced it.
 *
 * Returning reasons rather than just a number lets the UI explain *why* a row ranked
 * where it did, which is the difference between a score the user trusts and a magic
 * number they ignore.
 *
 * @returns {{score: number, reasons: Array<{label: string, weight: number}>}}
 */
export function interestBreakdown(value, { kind = 'endpoint' } = {}) {
  const lower = String(value).toLowerCase();
  const reasons = [];

  for (const [term, weight] of INTEREST_TERMS) {
    if (lower.includes(term)) reasons.push({ label: `contains "${term}"`, weight });
  }

  // Write-shaped verbs are more interesting than reads when unreached.
  if (/^(?:post|put|patch|delete)\s/i.test(value)) {
    reasons.push({ label: 'write-shaped method', weight: 2 });
  }

  // An older API version on an app that mostly speaks a newer one is a classic find.
  if (/\/v1\b/.test(lower)) reasons.push({ label: 'older API version (v1)', weight: 1 });
  if (/\/v0\b/.test(lower)) reasons.push({ label: 'older API version (v0)', weight: 2 });

  if (kind === 'role') reasons.push({ label: 'role or permission string', weight: 2 });
  if (kind === 'gqlop') reasons.push({ label: 'GraphQL operation', weight: 1 });

  // Deeply nested paths tend to be more specific and more interesting.
  const depth = lower.split('/').length - 1;
  if (depth >= 4) reasons.push({ label: 'deeply nested path', weight: 1 });

  return {
    score: reasons.reduce((sum, reason) => sum + reason.weight, 0),
    reasons: reasons.sort((a, b) => b.weight - a.weight),
  };
}

/** Score only. Kept as the hot path for mining, where reasons are not needed. */
export function interestScore(value, options) {
  return interestBreakdown(value, options).score;
}
