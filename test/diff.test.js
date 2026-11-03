import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pathKey,
  reconcileReached,
  unreached,
  newSince,
  previousSession,
  buildTimeline,
  glance,
} from '../src/lib/diff.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// t0 is an arbitrary fixed epoch so tests are deterministic.
const t0 = 1_760_000_000_000;

function obs(overrides) {
  return {
    id: Math.random().toString(36),
    programId: 'p1',
    kind: 'endpoint',
    value: '/api/thing',
    source: 'mined',
    reached: false,
    dismissed: false,
    firstSeen: t0,
    lastSeen: t0,
    interest: 0,
    hits: 1,
    ...overrides,
  };
}

test('pathKey strips method, host and query names for cross-source comparison', () => {
  assert.equal(pathKey({ value: 'GET app.target.com/api/users/{id}' }), '/api/users/{id}');
  assert.equal(pathKey({ value: 'POST app.target.com/api/me?id&token' }), '/api/me');
  assert.equal(pathKey({ value: '/api/users/{id}' }), '/api/users/{id}');
});

test('a mined endpoint is reached once runtime observes the same path', () => {
  const result = reconcileReached([
    obs({ value: '/api/users/{id}', source: 'mined' }),
    obs({ value: 'GET app.target.com/api/users/{id}', source: 'runtime' }),
  ]);
  assert.equal(result.find((o) => o.source === 'mined').reached, true);
});

test('a mined endpoint nobody called stays unreached', () => {
  const result = reconcileReached([
    obs({ value: '/api/internal/impersonate', source: 'mined' }),
    obs({ value: 'GET app.target.com/api/users/{id}', source: 'runtime' }),
  ]);
  assert.equal(result.find((o) => o.value.includes('impersonate')).reached, false);
});

test('reconcile does not mutate its input', () => {
  const input = [obs({ value: '/x', source: 'mined' }), obs({ value: 'GET h/x', source: 'runtime' })];
  const before = JSON.stringify(input);
  reconcileReached(input);
  assert.equal(JSON.stringify(input), before);
});

test('a manual "mark reached" is never undone by reconciliation', () => {
  const result = reconcileReached([obs({ value: '/api/secret', source: 'mined', reached: true })]);
  assert.equal(result[0].reached, true);
});

test('the headline view: declared, never reached, most interesting first', () => {
  const list = unreached([
    obs({ value: '/api/v2/profile', interest: 0 }),
    obs({ value: '/api/internal/impersonate', interest: 9 }),
    obs({ value: '/admin/exports', interest: 7 }),
    // excluded: reached
    obs({ value: '/api/users/{id}', source: 'mined' }),
    obs({ value: 'GET h/api/users/{id}', source: 'runtime' }),
    // excluded: dismissed
    obs({ value: '/i18n/thing', dismissed: true, interest: 99 }),
    // excluded: runtime observations are by definition reached
    obs({ value: 'GET h/api/other', source: 'runtime', interest: 50 }),
  ]);

  assert.deepEqual(
    list.map((o) => o.value),
    ['/api/internal/impersonate', '/admin/exports', '/api/v2/profile'],
  );
});

test('unreached can be filtered by kind', () => {
  const list = unreached(
    [obs({ kind: 'endpoint', value: '/a' }), obs({ kind: 'flag', value: 'x.y' })],
    { kinds: ['flag'] },
  );
  assert.deepEqual(list.map((o) => o.value), ['x.y']);
});

test('newSince returns only surface first seen after the cutoff', () => {
  const list = newSince(
    [
      obs({ value: '/old', firstSeen: t0 }),
      obs({ value: '/new', firstSeen: t0 + 10 * DAY }),
      obs({ value: '/dismissed', firstSeen: t0 + 10 * DAY, dismissed: true }),
    ],
    t0 + DAY,
  );
  assert.deepEqual(list.map((o) => o.value), ['/new']);
});

test('previousSession walks back one visit', () => {
  const sessions = [
    { id: 1, startedAt: t0, endedAt: t0 + HOUR },
    { id: 2, startedAt: t0 + 10 * DAY, endedAt: t0 + 10 * DAY + HOUR },
  ];
  assert.equal(previousSession(sessions, 2).id, 1);
  assert.equal(previousSession(sessions, 1), null);
  assert.equal(previousSession(sessions, 99), null);
});

test('timeline is newest first and attributes surface to the right visit', () => {
  const sessions = [
    { id: 1, startedAt: t0, endedAt: t0 + HOUR },
    { id: 2, startedAt: t0 + 23 * DAY, endedAt: t0 + 23 * DAY + HOUR },
  ];
  const observations = [
    obs({ value: '/api/users', firstSeen: t0 + MIN }),
    obs({ value: '/api/v2/export', firstSeen: t0 + 23 * DAY + MIN }),
    obs({ value: '/api/internal/impersonate', firstSeen: t0 + 23 * DAY + 2 * MIN, interest: 9 }),
  ];
  const events = [
    { at: t0 + 23 * DAY + 3 * MIN, type: 'asset-changed', detail: 'main.a81f.js' },
  ];

  const timeline = buildTimeline(sessions, observations, events);

  assert.equal(timeline.length, 2);
  // Newest first.
  assert.equal(timeline[0].sessionId, 2);
  assert.deepEqual(timeline[0].appeared.map((o) => o.value), [
    '/api/internal/impersonate',
    '/api/v2/export',
  ]);
  assert.equal(timeline[0].counts.endpoint, 2);
  assert.equal(timeline[0].changes.length, 1);
  // The "last seen 23 days ago" line.
  assert.equal(timeline[0].gapSincePrevious, 23 * DAY - HOUR);
  assert.equal(timeline[0].isFirstVisit, false);

  assert.equal(timeline[1].sessionId, 1);
  assert.equal(timeline[1].isFirstVisit, true);
  assert.equal(timeline[1].gapSincePrevious, null);
  assert.deepEqual(timeline[1].appeared.map((o) => o.value), ['/api/users']);
});

test('timeline tolerates an open session with no end time', () => {
  const timeline = buildTimeline(
    [{ id: 1, startedAt: t0, endedAt: null }],
    [obs({ value: '/api/x', firstSeen: t0 + MIN })],
  );
  assert.equal(timeline[0].appeared.length, 1);
});

test('glance summarises what is new since the previous visit', () => {
  const sessions = [
    { id: 1, startedAt: t0, endedAt: t0 + HOUR },
    { id: 2, startedAt: t0 + 23 * DAY, endedAt: null },
  ];
  const observations = [
    obs({ value: '/api/users', firstSeen: t0 + MIN }),
    obs({ value: '/api/v2/export', firstSeen: t0 + 23 * DAY + MIN }),
    obs({ value: 'billing.bulk_refund', kind: 'flag', firstSeen: t0 + 23 * DAY + MIN }),
  ];
  const events = [{ at: t0 + 23 * DAY + MIN, type: 'asset-changed', detail: 'main.js' }];

  const result = glance(sessions, observations, events);

  assert.equal(result.isFirstVisit, false);
  assert.equal(result.newCount, 2);
  assert.equal(result.changeCount, 1);
  assert.equal(result.lastSeen, t0 + HOUR);
  assert.equal(result.byKind.endpoint, 1);
  assert.equal(result.byKind.flag, 1);
});

test('glance on a first-ever visit reports no baseline', () => {
  const result = glance(
    [{ id: 1, startedAt: t0, endedAt: null }],
    [obs({ value: '/api/users', firstSeen: t0 + MIN })],
  );
  assert.equal(result.isFirstVisit, true);
  assert.equal(result.lastSeen, null);
});

test('glance with no sessions at all does not throw', () => {
  const result = glance([], []);
  assert.equal(result.isFirstVisit, true);
  assert.equal(result.newCount, 0);
});
