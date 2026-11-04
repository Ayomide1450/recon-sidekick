// IndexedDB access layer. Thin promise wrappers over the stores described in the
// design doc. No business logic here — that lives in src/lib/.

const DB_NAME = 'recon-sidekick';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('observations')) {
        const store = db.createObjectStore('observations', { keyPath: 'id' });
        store.createIndex('by_program', 'programId');
        store.createIndex('by_program_kind', ['programId', 'kind']);
      }
      if (!db.objectStoreNames.contains('assets')) {
        const store = db.createObjectStore('assets', { keyPath: 'id' });
        store.createIndex('by_program', 'programId');
      }
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_program', 'programId');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const store = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_program', 'programId');
      }
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'programId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx(db, storeNames, mode) {
  const transaction = db.transaction(storeNames, mode);
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return { transaction, done };
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllByProgram(storeName, programId) {
  const db = await openDb();
  const { transaction } = tx(db, [storeName], 'readonly');
  const index = transaction.objectStore(storeName).index('by_program');
  return req(index.getAll(IDBKeyRange.only(programId)));
}

export async function getAll(storeName) {
  const db = await openDb();
  const { transaction } = tx(db, [storeName], 'readonly');
  return req(transaction.objectStore(storeName).getAll());
}

export async function get(storeName, key) {
  const db = await openDb();
  const { transaction } = tx(db, [storeName], 'readonly');
  return req(transaction.objectStore(storeName).get(key));
}

export async function put(storeName, value) {
  const db = await openDb();
  const { transaction, done } = tx(db, [storeName], 'readwrite');
  transaction.objectStore(storeName).put(value);
  await done;
  return value;
}

export async function add(storeName, value) {
  const db = await openDb();
  const { transaction, done } = tx(db, [storeName], 'readwrite');
  const key = await req(transaction.objectStore(storeName).add(value));
  await done;
  return key;
}

/**
 * Upsert a batch of observations in a single transaction.
 *
 * `merge(existing, incoming)` decides the stored record. This is where firstSeen is
 * preserved and lastSeen/hits advance.
 */
export async function upsertObservations(records, merge) {
  if (!records.length) return [];
  const db = await openDb();

  // Read first, in its own transaction. Awaiting between operations inside a single
  // readwrite transaction risks the transaction auto-committing mid-loop — IndexedDB
  // deactivates a transaction once the task that created it yields. Reading and writing
  // in two phases, with no await inside the write phase, avoids that entirely.
  const existingById = new Map();
  {
    const { transaction } = tx(db, ['observations'], 'readonly');
    const store = transaction.objectStore('observations');
    const found = await Promise.all(records.map((record) => req(store.get(record.id))));
    found.forEach((value, index) => {
      if (value) existingById.set(records[index].id, value);
    });
  }

  const written = [];
  const { transaction, done } = tx(db, ['observations'], 'readwrite');
  const store = transaction.objectStore('observations');
  for (const incoming of records) {
    const existing = existingById.get(incoming.id);
    const merged = merge(existing, incoming);
    if (!merged) continue;
    store.put(merged);
    written.push({ record: merged, isNew: !existing });
  }
  await done;
  return written;
}

/** Apply a set of deletes and puts to one store in a single transaction. */
export async function applyBatch(storeName, { deletes = [], puts = [] }) {
  if (!deletes.length && !puts.length) return 0;
  const db = await openDb();
  const { transaction, done } = tx(db, [storeName], 'readwrite');
  const store = transaction.objectStore(storeName);
  // No awaits inside the write phase — see the note in upsertObservations.
  for (const key of deletes) store.delete(key);
  for (const value of puts) store.put(value);
  await done;
  return deletes.length + puts.length;
}

export async function deleteByProgram(storeName, programId) {
  const db = await openDb();
  const { transaction, done } = tx(db, [storeName], 'readwrite');
  const store = transaction.objectStore(storeName);
  const keys = await req(store.index('by_program').getAllKeys(IDBKeyRange.only(programId)));
  for (const key of keys) store.delete(key);
  await done;
  return keys.length;
}

export async function purgeProgram(programId) {
  let total = 0;
  for (const storeName of ['observations', 'assets', 'events', 'sessions']) {
    total += await deleteByProgram(storeName, programId);
  }
  const db = await openDb();
  const { transaction, done } = tx(db, ['notes'], 'readwrite');
  transaction.objectStore('notes').delete(programId);
  await done;
  return total;
}

export async function countByProgram(programId) {
  const counts = {};
  for (const storeName of ['observations', 'assets', 'events', 'sessions']) {
    const rows = await getAllByProgram(storeName, programId);
    counts[storeName] = rows.length;
  }
  return counts;
}

/** Rough storage usage, for the size readout in the dashboard. */
export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
