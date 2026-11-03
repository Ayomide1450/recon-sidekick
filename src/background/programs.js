// Armed program storage, host permissions, and dynamic content script registration.
//
// Content scripts are NOT declared in the manifest. They are registered at arm time for
// the specific origins the user opted into, so the extension has no ability to observe
// anything else. Arming a program triggers a permission prompt for exactly those hosts.

import { toMatchPatterns, validateHostPattern } from '../lib/scope.js';

const KEY = 'programs';
const SCRIPT_ID_PREFIX = 'recon-agent-';

export async function listPrograms() {
  const stored = await chrome.storage.local.get(KEY);
  return stored[KEY] || [];
}

async function savePrograms(programs) {
  await chrome.storage.local.set({ [KEY]: programs });
  return programs;
}

/** Permission match patterns for every enabled program. */
async function armedMatchPatterns() {
  const programs = await listPrograms();
  const patterns = new Set();
  for (const program of programs) {
    if (!program.enabled) continue;
    for (const host of program.hosts || []) {
      for (const pattern of toMatchPatterns(host)) patterns.add(pattern);
    }
  }
  return [...patterns];
}

/**
 * Re-register the page agent for exactly the currently armed origins.
 *
 * Called after any scope change and on startup. Unregistering first makes this
 * idempotent, which matters because the service worker can restart at any time.
 */
export async function syncContentScripts() {
  const matches = await armedMatchPatterns();

  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ours = existing
    .filter((script) => script.id.startsWith(SCRIPT_ID_PREFIX))
    .map((script) => script.id);
  if (ours.length) {
    await chrome.scripting.unregisterContentScripts({ ids: ours });
  }

  if (!matches.length) return { registered: 0 };

  // Only register for origins we actually hold permission for; Chrome rejects the whole
  // call otherwise, which would silently disarm every program.
  const granted = [];
  for (const match of matches) {
    if (await chrome.permissions.contains({ origins: [match] })) granted.push(match);
  }
  if (!granted.length) return { registered: 0 };

  await chrome.scripting.registerContentScripts([
    {
      // The MAIN-world agent, which can see the page's own fetch/XHR.
      id: `${SCRIPT_ID_PREFIX}main`,
      matches: granted,
      js: ['src/agent/page-agent.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    },
    {
      // The isolated-world relay, which is the only thing that can talk to the worker.
      id: `${SCRIPT_ID_PREFIX}relay`,
      matches: granted,
      js: ['src/agent/relay.js'],
      runAt: 'document_start',
      world: 'ISOLATED',
      allFrames: true,
    },
  ]);

  return { registered: granted.length };
}

/**
 * Arm a new program. Requests host permissions, which must be called from a user
 * gesture in an extension page (the popup or dashboard), not from the worker.
 */
export async function addProgram({ name, hosts }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Program needs a name');

  const cleanHosts = [...new Set((hosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))];
  if (!cleanHosts.length) throw new Error('Program needs at least one host');

  for (const host of cleanHosts) {
    const error = validateHostPattern(host);
    if (error) throw new Error(`${host}: ${error}`);
  }

  const program = {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: cleanName,
    hosts: cleanHosts,
    enabled: true,
    createdAt: Date.now(),
  };

  const programs = await listPrograms();
  programs.push(program);
  await savePrograms(programs);
  await syncContentScripts();
  return program;
}

export async function updateProgram(id, patch) {
  const programs = await listPrograms();
  const index = programs.findIndex((p) => p.id === id);
  if (index === -1) throw new Error('No such program');

  if (patch.hosts) {
    for (const host of patch.hosts) {
      const error = validateHostPattern(host);
      if (error) throw new Error(`${host}: ${error}`);
    }
  }

  programs[index] = { ...programs[index], ...patch, id };
  await savePrograms(programs);
  await syncContentScripts();
  return programs[index];
}

export async function removeProgram(id) {
  const programs = await listPrograms();
  await savePrograms(programs.filter((p) => p.id !== id));
  await syncContentScripts();
}

/** The origin patterns a program needs, for a permission request from the UI. */
export async function originsForProgram(hosts) {
  const patterns = new Set();
  for (const host of hosts || []) {
    for (const pattern of toMatchPatterns(host)) patterns.add(pattern);
  }
  return [...patterns];
}
