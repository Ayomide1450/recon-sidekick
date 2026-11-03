// Bundle mining: extract the surface a client bundle *declares* exists.
//
// Pure function over a string. The caller is responsible for fetching the asset and
// for persisting what comes back.

import {
  PATH_PATTERN,
  GQL_PATTERN,
  FLAG_PATTERN,
  ROLE_PATTERN,
  isNoise,
  isFlagNoise,
  interestScore,
} from './rules.js';
import { normalizeRoute } from './normalize.js';

// A route is a path containing a parameter placeholder, or sitting under a known
// client-routing prefix. Everything else path-shaped is treated as an endpoint.
const ROUTE_HINT = /[:*]|\{[^}]+\}|\[[^\]]+\]/;
const ENDPOINT_HINT = /^\/(?:api|graphql|gql|rest|v\d|internal|rpc|_api|service)/i;

/** Bounded de-duplicating accumulator so a pathological bundle cannot exhaust memory. */
const MAX_PER_KIND = 2000;

function collect(text, pattern, group = 1) {
  const out = new Set();
  // Patterns are module-level and carry lastIndex state between calls; reset it.
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[group];
    if (value) out.add(value);
    if (out.size >= MAX_PER_KIND * 4) break;
  }
  return out;
}

/**
 * Mine a JS bundle for declared surface.
 *
 * @param {string} text - the bundle source
 * @returns {Array<{kind: string, value: string, raw: string, interest: number}>}
 */
export function mineBundle(text) {
  if (typeof text !== 'string' || !text) return [];

  const results = new Map(); // dedup key -> record

  const add = (kind, value, raw) => {
    const key = `${kind}|${value}`;
    if (results.has(key) || results.size >= MAX_PER_KIND * 5) return;
    results.set(key, {
      kind,
      value,
      raw: raw ?? value,
      interest: interestScore(value, { kind }),
    });
  };

  for (const path of collect(text, PATH_PATTERN)) {
    if (isNoise(path)) continue;
    const isRoute = ROUTE_HINT.test(path) && !ENDPOINT_HINT.test(path);
    const normalized = normalizeRoute(path);
    if (!normalized) continue;
    // Mined paths have no observed HTTP method. They are stored method-less and the
    // diff layer compares them against the path portion of reached endpoints.
    add(isRoute ? 'route' : 'endpoint', normalized.value, path);
  }

  for (const op of collect(text, GQL_PATTERN)) {
    add('gqlop', op);
  }

  for (const flag of collect(text, FLAG_PATTERN)) {
    if (isFlagNoise(flag)) continue;
    add('flag', flag);
  }

  for (const role of collect(text, ROLE_PATTERN)) {
    if (role.length < 4 || role.length > 48) continue;
    add('role', role);
  }

  return [...results.values()];
}

/**
 * Stable content hash for change detection across sessions.
 * FNV-1a — not cryptographic, just a cheap fingerprint for "did this bundle change".
 */
export function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Mix in the length so trivially different bundles of the same character multiset
  // cannot collide.
  return `${(hash >>> 0).toString(16)}-${text.length.toString(16)}`;
}
