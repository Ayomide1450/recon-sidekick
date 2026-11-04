// Service worker entry point: message routing and lifecycle.

import { programForUrl } from '../lib/scope.js';
import { unreached, buildTimeline, glance, reconcileReached } from '../lib/diff.js';
import { interestBreakdown } from '../lib/rules.js';
import { summarize } from '../lib/summary.js';
import {
  listPrograms,
  addProgram,
  updateProgram,
  removeProgram,
  syncContentScripts,
  originsForProgram,
} from './programs.js';
import { recordRuntime, setObservationFlags, clearSessionCache } from './collector.js';
import { considerAsset, clearMinerCache } from './miner.js';
import { runMigrations } from './migrate.js';
import * as db from './db.js';

// The worker can be torn down at any time; re-sync registration whenever it wakes so
// armed programs never silently stop recording.
chrome.runtime.onStartup.addListener(() => { void bootstrap(); });
chrome.runtime.onInstalled.addListener(() => { void bootstrap(); });

async function bootstrap() {
  clearSessionCache();
  clearMinerCache();
  try {
    await runMigrations();
  } catch (error) {
    // A failed migration must not stop the extension from recording.
    console.warn('[recon-sidekick] migration failed', error);
  }
  try {
    await syncContentScripts();
  } catch (error) {
    console.warn('[recon-sidekick] content script sync failed', error);
  }
}

// Re-sync if the user revokes or grants host permissions outside our own flow.
chrome.permissions.onAdded?.addListener(() => { void syncContentScripts(); });
chrome.permissions.onRemoved?.addListener(() => { void syncContentScripts(); });

/** Reflect armed state in the toolbar icon so scope mistakes are visible, not silent. */
async function refreshActionForTab(tabId, url) {
  try {
    const programs = await listPrograms();
    const program = programForUrl(url, programs);
    await chrome.action.setTitle({
      tabId,
      title: program
        ? `Recon Sidekick — recording "${program.name}"`
        : 'Recon Sidekick — not armed for this host',
    });
    if (!program) await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    // Tab may have closed mid-flight.
  }
}

chrome.tabs?.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) void refreshActionForTab(tabId, tab.url);
});
chrome.tabs?.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) await refreshActionForTab(tabId, tab.url);
  } catch {
    // Ignore.
  }
});

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

const handlers = {
  async 'observations:report'({ items }, sender) {
    const pageUrl = sender?.url || sender?.tab?.url;
    if (!pageUrl) return { stored: 0 };

    // Script sightings come from the page's resource timing rather than webRequest.
    // They are not observations in their own right — they are input to the miner.
    const scripts = [];
    const observations = [];
    for (const item of items || []) {
      if (item?.type === 'script') scripts.push(item.url);
      else observations.push(item);
    }

    for (const url of scripts) void considerAsset(url, pageUrl);

    return recordRuntime(observations, pageUrl);
  },

  async 'programs:list'() {
    return listPrograms();
  },

  async 'programs:add'({ name, hosts }) {
    return addProgram({ name, hosts });
  },

  async 'programs:update'({ id, patch }) {
    return updateProgram(id, patch);
  },

  async 'programs:remove'({ id }) {
    await removeProgram(id);
    return { ok: true };
  },

  async 'programs:origins'({ hosts }) {
    return originsForProgram(hosts);
  },

  async 'programs:sync'() {
    return syncContentScripts();
  },

  async 'program:for-url'({ url }) {
    const programs = await listPrograms();
    return programForUrl(url, programs);
  },

  async 'view:glance'({ programId }) {
    const [sessions, observations, events] = await Promise.all([
      db.getAllByProgram('sessions', programId),
      db.getAllByProgram('observations', programId),
      db.getAllByProgram('events', programId),
    ]);
    return glance(sessions, observations, events);
  },

  async 'view:timeline'({ programId }) {
    const [sessions, observations, events] = await Promise.all([
      db.getAllByProgram('sessions', programId),
      db.getAllByProgram('observations', programId),
      db.getAllByProgram('events', programId),
    ]);
    return buildTimeline(sessions, observations, events);
  },

  async 'view:unreached'({ programId, kinds }) {
    const observations = await db.getAllByProgram('observations', programId);
    // Attach the scoring breakdown so each row can explain its own rank on demand.
    return unreached(observations, { kinds: kinds || null }).map((obs) => ({
      ...obs,
      reasons: interestBreakdown(obs.value, { kind: obs.kind }).reasons,
    }));
  },

  async 'view:overview'({ programId }) {
    const [observations, sessions, events, assets] = await Promise.all([
      db.getAllByProgram('observations', programId),
      db.getAllByProgram('sessions', programId),
      db.getAllByProgram('events', programId),
      db.getAllByProgram('assets', programId),
    ]);
    return summarize({ observations, sessions, events, assets });
  },

  async 'view:surface'({ programId }) {
    const observations = await db.getAllByProgram('observations', programId);
    return reconcileReached(observations).sort(
      (a, b) => b.interest - a.interest || a.value.localeCompare(b.value),
    );
  },

  async 'observation:flags'({ id, dismissed, reached }) {
    return setObservationFlags(id, { dismissed, reached });
  },

  async 'notes:get'({ programId }) {
    return (await db.get('notes', programId)) || { programId, text: '', updatedAt: null };
  },

  async 'notes:set'({ programId, text }) {
    return db.put('notes', { programId, text, updatedAt: Date.now() });
  },

  async 'program:stats'({ programId }) {
    const [counts, usage] = await Promise.all([
      db.countByProgram(programId),
      db.estimateUsage(),
    ]);
    return { counts, usage };
  },

  async 'program:purge'({ programId }) {
    const deleted = await db.purgeProgram(programId);
    clearSessionCache();
    clearMinerCache();
    return { deleted };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
    return false;
  }
  handler(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  // Keep the message channel open for the async response.
  return true;
});

void bootstrap();
