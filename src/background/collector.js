// The collector: normalize, gate on scope, dedupe, persist.
//
// Every write to the database flows through here, which makes this the right place to
// enforce the privacy invariants from the design doc.

import { normalizeEndpoint, normalizeRoute } from '../lib/normalize.js';
import { interestScore } from '../lib/rules.js';
import { programForUrl } from '../lib/scope.js';
import { SESSION_IDLE_MS } from '../lib/diff.js';
import { listPrograms } from './programs.js';
import * as db from './db.js';

/** In-memory cache of the open session per program. Rebuilt on worker restart. */
const openSessions = new Map();

function observationId(programId, kind, value) {
  return `${programId}|${kind}|${value}`;
}

/**
 * Preserve firstSeen, advance lastSeen, and never let a re-observation resurrect a
 * dismissed row or clobber a manual "mark reached".
 */
function mergeObservation(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    lastSeen: Math.max(existing.lastSeen, incoming.lastSeen),
    hits: (existing.hits || 0) + (incoming.hits || 1),
    // A runtime sighting is stronger evidence than a mined guess: upgrade the source so
    // the row counts as reached from here on.
    source: existing.source === 'runtime' || incoming.source === 'runtime' ? 'runtime' : existing.source,
    reached: existing.reached || incoming.source === 'runtime',
    // Keep the first raw example we captured.
    raw: existing.raw || incoming.raw,
  };
}

/**
 * Find or open the current session for a program. Sessions close after an idle gap, so
 * "what changed since last time" lines up with how hunting actually happens: a block of
 * focused poking, then days of nothing.
 */
async function currentSession(programId, now) {
  const cached = openSessions.get(programId);
  if (cached && now - cached.endedAt <= SESSION_IDLE_MS) {
    cached.endedAt = now;
    await db.put('sessions', cached);
    return cached;
  }

  const sessions = await db.getAllByProgram('sessions', programId);
  sessions.sort((a, b) => a.startedAt - b.startedAt);
  const last = sessions[sessions.length - 1];

  if (last && now - (last.endedAt ?? last.startedAt) <= SESSION_IDLE_MS) {
    last.endedAt = now;
    openSessions.set(programId, last);
    await db.put('sessions', last);
    return last;
  }

  const session = { programId, startedAt: now, endedAt: now };
  const id = await db.add('sessions', session);
  session.id = id;
  openSessions.set(programId, session);
  return session;
}

/**
 * Record runtime observations reported by the page agent.
 *
 * @param {Array<{type: string, url: string, method?: string}>} items
 * @param {string} pageUrl - the URL of the frame that reported, used as the resolve base
 */
export async function recordRuntime(items, pageUrl) {
  if (!Array.isArray(items) || !items.length) return { stored: 0 };

  const programs = await listPrograms();
  const program = programForUrl(pageUrl, programs);
  // The gate. An unarmed page never reaches storage, no matter what it reports.
  if (!program) return { stored: 0, reason: 'unarmed' };

  const now = Date.now();
  const session = await currentSession(program.id, now);
  const records = [];

  for (const item of items) {
    if (!item?.url) continue;

    // A page can report a request to any host. Only keep hosts inside this program's
    // scope — otherwise a third-party analytics call would pollute the target's record.
    let absoluteUrl;
    try {
      absoluteUrl = new URL(item.url, pageUrl).href;
    } catch {
      continue; // Malformed URL from an untrusted page; drop it.
    }
    const targetProgram = programForUrl(absoluteUrl, programs);
    if (!targetProgram || targetProgram.id !== program.id) continue;

    let normalized;
    let kind;
    if (item.type === 'route') {
      normalized = normalizeRoute(item.url, { base: pageUrl });
      kind = 'route';
    } else {
      normalized = normalizeEndpoint(item.url, { method: item.method, base: pageUrl });
      kind = 'endpoint';
    }
    if (!normalized) continue;

    records.push({
      id: observationId(program.id, kind, normalized.value),
      programId: program.id,
      kind,
      value: normalized.value,
      raw: normalized.raw,
      source: 'runtime',
      reached: true,
      dismissed: false,
      firstSeen: now,
      lastSeen: now,
      hits: 1,
      interest: interestScore(normalized.value, { kind }),
      sessionId: session.id,
    });
  }

  const written = await db.upsertObservations(records, mergeObservation);
  const fresh = written.filter((w) => w.isNew).length;
  if (fresh) await bumpBadge(program.id);
  return { stored: written.length, new: fresh, programId: program.id };
}

/**
 * Record mined surface from a bundle.
 */
export async function recordMined(programId, assetUrl, items, hash) {
  const now = Date.now();
  const session = await currentSession(programId, now);

  const assetId = `${programId}|${assetUrl}`;
  const existingAsset = await db.get('assets', assetId);

  if (existingAsset && existingAsset.hash !== hash) {
    // A changed bundle is a mutation of an existing row, so unlike new surface it has
    // to be stored as an explicit event to survive in the timeline.
    await db.add('events', {
      programId,
      at: now,
      type: 'asset-changed',
      detail: assetUrl,
      from: existingAsset.hash,
      to: hash,
    });
  }

  await db.put('assets', {
    id: assetId,
    programId,
    url: assetUrl,
    hash,
    firstSeen: existingAsset?.firstSeen ?? now,
    lastSeen: now,
  });

  const records = (items || []).map((item) => ({
    id: observationId(programId, item.kind, item.value),
    programId,
    kind: item.kind,
    value: item.value,
    raw: item.raw,
    source: 'mined',
    reached: false,
    dismissed: false,
    firstSeen: now,
    lastSeen: now,
    hits: 1,
    interest: item.interest ?? interestScore(item.value, { kind: item.kind }),
    sessionId: session.id,
    foundIn: assetUrl,
  }));

  const written = await db.upsertObservations(records, mergeObservation);
  const fresh = written.filter((w) => w.isNew).length;
  if (fresh) await bumpBadge(programId);
  return { stored: written.length, new: fresh };
}

/** Mark a row dismissed (noise) or reached (already tested). */
export async function setObservationFlags(id, { dismissed, reached }) {
  const existing = await db.get('observations', id);
  if (!existing) return null;
  const updated = { ...existing };
  if (dismissed !== undefined) updated.dismissed = !!dismissed;
  if (reached !== undefined) updated.reached = !!reached;
  await db.put('observations', updated);
  return updated;
}

/**
 * Badge shows how much new surface has appeared in the current session — the ambient
 * signal that something worth looking at turned up while you were browsing.
 */
async function bumpBadge(programId) {
  try {
    const session = openSessions.get(programId);
    if (!session) return;
    const observations = await db.getAllByProgram('observations', programId);
    const count = observations.filter(
      (obs) => !obs.dismissed && obs.firstSeen >= session.startedAt,
    ).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 999)) : '' });
  } catch {
    // Badge updates are cosmetic; never let one break collection.
  }
}

export function clearSessionCache() {
  openSessions.clear();
}
