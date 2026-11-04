import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReclassification } from '../src/lib/migrate.js';

const base = {
  programId: 'p1',
  source: 'mined',
  reached: false,
  dismissed: false,
  firstSeen: 100,
  lastSeen: 200,
  hits: 1,
  interest: 4,
};

const mined = (value, over = {}) => ({
  ...base,
  ...over,
  id: `p1|${over.kind || 'endpoint'}|${value}`,
  kind: over.kind || 'endpoint',
  value,
});

test('reclassifies a mislabelled admin endpoint into a route, with a new id', () => {
  const plan = planReclassification([mined('/admin/settings')]);
  assert.equal(plan.changed, 1);
  assert.deepEqual(plan.deletes, ['p1|endpoint|/admin/settings']);
  assert.equal(plan.puts.length, 1);
  assert.equal(plan.puts[0].id, 'p1|route|/admin/settings');
  assert.equal(plan.puts[0].kind, 'route');
});

test('leaves correctly-classified endpoints alone', () => {
  const plan = planReclassification([mined('/api/v1/users')]);
  assert.equal(plan.changed, 0);
  assert.equal(plan.puts.length, 0);
});

test('never touches runtime observations', () => {
  const runtime = {
    ...base,
    id: 'p1|endpoint|GET app.x.com/admin/settings',
    kind: 'endpoint',
    source: 'runtime',
    reached: true,
    value: 'GET app.x.com/admin/settings',
  };
  const plan = planReclassification([runtime]);
  assert.equal(plan.changed, 0);
});

test('merges into an existing route row, preserving dismiss and reached flags', () => {
  // The route already exists (user dismissed it); the mislabelled endpoint collapses in.
  const existingRoute = mined('/admin/settings', { kind: 'route', dismissed: true, firstSeen: 50, hits: 3 });
  const wrongEndpoint = mined('/admin/settings', { kind: 'endpoint', reached: true, firstSeen: 100, hits: 2, interest: 6 });

  const plan = planReclassification([existingRoute, wrongEndpoint]);

  assert.deepEqual(plan.deletes, ['p1|endpoint|/admin/settings']);
  const merged = plan.puts.find((p) => p.id === 'p1|route|/admin/settings');
  assert.equal(merged.dismissed, true, 'dismissal preserved');
  assert.equal(merged.reached, true, 'reached preserved');
  assert.equal(merged.firstSeen, 50, 'earliest firstSeen kept');
  assert.equal(merged.hits, 5, 'hits summed');
  assert.equal(merged.interest, 6, 'highest interest kept');
});

test('is idempotent: a second run changes nothing', () => {
  const first = planReclassification([mined('/admin/settings')]);
  // Simulate the applied state: the row now lives under its route id.
  const applied = first.puts;
  const second = planReclassification(applied);
  assert.equal(second.changed, 0);
});

test('handles many mislabelled rows from a real-looking admin section', () => {
  const paths = ['/admin', '/admin/2fa', '/admin/admins', '/admin/audit-log', '/admin/campaigns'];
  const plan = planReclassification(paths.map((p) => mined(p)));
  assert.equal(plan.changed, 5);
  assert.ok(plan.puts.every((p) => p.kind === 'route'));
});
