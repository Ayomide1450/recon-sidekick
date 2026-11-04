import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, clusters, VIEW_HELP } from '../src/lib/summary.js';

const obs = (value, over = {}) => ({
  id: Math.random().toString(36),
  programId: 'p1',
  kind: over.kind || (value.includes('/api') ? 'endpoint' : 'route'),
  value,
  source: over.source || 'mined',
  reached: over.reached || false,
  dismissed: over.dismissed || false,
  firstSeen: over.firstSeen || 100,
  lastSeen: 200,
  interest: over.interest ?? 4,
  hits: 1,
});

test('clusters group by meaningful top segment, skipping api prefixes', () => {
  const result = clusters([
    obs('/admin/settings'),
    obs('/admin/audit-log'),
    obs('/api/admin/users'),
    obs('/billing/invoices'),
  ]);
  const admin = result.find((c) => c.segment === 'admin');
  assert.equal(admin.count, 3, '/api/admin/users should also land under admin');
  assert.ok(result.some((c) => c.segment === 'billing'));
});

test('summary separates reached from unreached and computes coverage', () => {
  const s = summarize({
    observations: [
      obs('/api/users/{id}', { source: 'mined' }),
      obs('GET app.x.com/api/users/{id}', { source: 'runtime', reached: true }),
      obs('/admin/settings', { source: 'mined' }),
      obs('/admin/secret', { source: 'mined' }),
    ],
    sessions: [{ id: 1, startedAt: 1000, endedAt: 2000 }],
  });
  // 3 mined; one is reached (matched by runtime). coverage = 1/3 ≈ 33%.
  assert.equal(s.totals.mined, 3);
  assert.equal(s.coverage, 33);
  assert.equal(s.totals.unreached, 2);
});

test('dismissed rows are excluded from totals and clusters', () => {
  const s = summarize({
    observations: [
      obs('/admin/a', { dismissed: true }),
      obs('/admin/b'),
    ],
  });
  assert.equal(s.totals.unreached, 1);
  assert.equal(s.totals.dismissed, 1);
});

test('insight fires on a cluster of unreached admin paths', () => {
  const s = summarize({
    observations: ['/admin/a', '/admin/b', '/admin/c', '/admin/d'].map((p) => obs(p)),
  });
  assert.ok(s.insights.some((i) => i.tone === 'hot' && /admin-area/.test(i.text)));
});

test('insight fires on an impersonation endpoint', () => {
  const s = summarize({ observations: [obs('/api/admin/impersonate')] });
  assert.ok(s.insights.some((i) => /impersonation/i.test(i.text)));
});

test('insight warns when nothing has been reached yet', () => {
  const s = summarize({ observations: [obs('/admin/x'), obs('/admin/y')] });
  assert.ok(s.insights.some((i) => i.tone === 'warn' && /Nothing is marked reached/.test(i.text)));
});

test('legacy-version insight needs both an old unreached and a new reached endpoint', () => {
  const s = summarize({
    observations: [
      obs('/api/v1/legacy', { source: 'mined' }),
      obs('GET app.x.com/api/v2/current', { source: 'runtime', reached: true }),
    ],
  });
  assert.ok(s.insights.some((i) => /older-version/.test(i.text)));
});

test('top findings are capped and ordered by interest', () => {
  const many = Array.from({ length: 20 }, (_, i) => obs(`/admin/p${i}`, { interest: i }));
  const s = summarize({ observations: many });
  assert.equal(s.topFindings.length, 8);
  assert.ok(s.topFindings[0].interest >= s.topFindings[7].interest);
});

test('an empty target does not throw and reports no coverage', () => {
  const s = summarize({});
  assert.equal(s.coverage, null);
  assert.equal(s.totals.all, 0);
  assert.deepEqual(s.insights, []);
});

test('view help text exists for every view', () => {
  for (const key of ['overview', 'unreached', 'timeline', 'surface', 'notes']) {
    assert.ok(VIEW_HELP[key] && VIEW_HELP[key].length > 20);
  }
});
