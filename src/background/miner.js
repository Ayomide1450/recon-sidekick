// Bundle fetching and mining orchestration.
//
// The only network activity in the extension. It re-fetches JS the browser already
// downloaded, served from cache, for armed hosts only. It never requests a URL the page
// did not already load, which is what keeps this a passive tool.

import { mineBundle, hashText } from '../lib/mine.js';
import { programForUrl } from '../lib/scope.js';
import { listPrograms } from './programs.js';
import { recordMined } from './collector.js';
import * as dbModule from './db.js';

/** Assets already mined this worker lifetime, to avoid redundant work. */
const seen = new Set();

/** Bundles above this size are skipped — the tail of value drops off a cliff. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Cap concurrent mining so a page loading 40 chunks cannot saturate the worker. */
let inFlight = 0;
const MAX_IN_FLIGHT = 3;
const queue = [];

function isMinableScript(url) {
  try {
    const { pathname, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return /\.(?:js|mjs|cjs)$/i.test(pathname) || /\/(?:bundle|chunk|main|app)[^/]*$/i.test(pathname);
  } catch {
    return false;
  }
}

async function mineOne(url, programId) {
  try {
    // cache: 'force-cache' keeps this off the network whenever possible, so mining does
    // not produce traffic the target could attribute to us.
    const response = await fetch(url, { cache: 'force-cache', credentials: 'omit' });
    if (!response.ok) return;

    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) return;

    const text = await response.text();
    if (text.length > MAX_BYTES) return;

    const hash = hashText(text);

    // If the content is unchanged since the last time we mined this URL, the mined
    // surface is unchanged too — skip the regex pass entirely.
    const existing = await dbModule.get('assets', `${programId}|${url}`);
    if (existing && existing.hash === hash) {
      await dbModule.put('assets', { ...existing, lastSeen: Date.now() });
      return;
    }

    const items = mineBundle(text);
    await recordMined(programId, url, items, hash);
  } catch {
    // A failed fetch (CORS, offline, cache miss on a revoked URL) is expected and not
    // worth surfacing. Mining is best-effort by design.
  }
}

function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    const job = queue.shift();
    inFlight++;
    mineOne(job.url, job.programId).finally(() => {
      inFlight--;
      pump();
    });
  }
}

/**
 * Consider a script URL for mining. Gated on armed scope and deduplicated.
 *
 * Script URLs arrive from the page agent's resource-timing observer, not from
 * webRequest — the extension requests no network-observation permission at all.
 */
export async function considerAsset(url, initiatorUrl) {
  if (!isMinableScript(url)) return;
  if (seen.has(url)) return;

  const programs = await listPrograms();
  // Mine when either the script's own host is armed, or the armed page loaded it. The
  // second case matters because targets routinely serve their bundle from a CDN host
  // nobody would think to add to scope — and it is still the target's code. The mined
  // surface is attributed to the program whose page pulled it in.
  const program = programForUrl(url, programs) || programForUrl(initiatorUrl, programs);
  if (!program) return;

  seen.add(url);
  queue.push({ url, programId: program.id });
  pump();
}

export function clearMinerCache() {
  seen.clear();
}
