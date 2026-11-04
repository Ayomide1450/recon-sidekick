// Applies pending data migrations at worker startup.

import { SCHEMA_VERSION, planReclassification } from '../lib/migrate.js';
import * as db from './db.js';

const KEY = 'schemaVersion';

export async function runMigrations() {
  const stored = await chrome.storage.local.get(KEY);
  // Treat an unset version as v1: that is what every database written before the
  // reclassification fix contains.
  const from = stored[KEY] ?? 1;
  if (from >= SCHEMA_VERSION) return { migrated: false, version: from };

  const observations = await db.getAll('observations');
  const plan = planReclassification(observations);
  await db.applyBatch('observations', plan);
  await chrome.storage.local.set({ [KEY]: SCHEMA_VERSION });

  console.info(
    `[recon-sidekick] migrated v${from} → v${SCHEMA_VERSION}: reclassified ${plan.changed} rows`,
  );
  return { migrated: true, from, version: SCHEMA_VERSION, changed: plan.changed };
}
