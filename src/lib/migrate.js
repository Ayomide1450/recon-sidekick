// Data migrations.
//
// Planning is kept pure so it can be tested without a browser; src/background/migrate.js
// applies the plan to IndexedDB.

import { classifyPath } from './rules.js';

export const SCHEMA_VERSION = 2;

/**
 * v2: reclassify mined paths that were stored as endpoints but are client routes.
 *
 * The original classifier only called something a route when it contained a parameter
 * placeholder, so whole admin sections (`/admin/settings`, `/admin/audit-log`) were
 * labelled endpoints. Because an observation's key embeds its kind, fixing this means
 * rewriting keys, not just fields — and two rows can collide when a route with the same
 * path already exists.
 *
 * @param {Array} observations
 * @returns {{deletes: string[], puts: object[], changed: number}}
 */
export function planReclassification(observations) {
  const byId = new Map(observations.map((obs) => [obs.id, obs]));
  const deletes = [];
  const puts = new Map();

  for (const obs of observations) {
    // Runtime observations carry a real observed method and host; they are correct by
    // construction and must not be touched.
    if (obs.source !== 'mined') continue;
    if (obs.kind !== 'endpoint') continue;

    const corrected = classifyPath(obs.value);
    if (corrected === 'endpoint') continue;

    const newId = `${obs.programId}|${corrected}|${obs.value}`;
    const moved = { ...obs, id: newId, kind: corrected };

    // A row may already exist at the destination, either in the original data or from
    // an earlier iteration of this loop. Merge rather than clobber, so a dismissal or a
    // manual "mark reached" is never silently lost.
    const existing = puts.get(newId) || byId.get(newId);
    if (existing) {
      puts.set(newId, {
        ...existing,
        id: newId,
        kind: corrected,
        firstSeen: Math.min(existing.firstSeen, moved.firstSeen),
        lastSeen: Math.max(existing.lastSeen, moved.lastSeen),
        hits: (existing.hits || 0) + (moved.hits || 0),
        reached: !!(existing.reached || moved.reached),
        dismissed: !!(existing.dismissed || moved.dismissed),
        raw: existing.raw || moved.raw,
        interest: Math.max(existing.interest || 0, moved.interest || 0),
      });
    } else {
      puts.set(newId, moved);
    }

    deletes.push(obs.id);
  }

  return { deletes, puts: [...puts.values()], changed: deletes.length };
}
