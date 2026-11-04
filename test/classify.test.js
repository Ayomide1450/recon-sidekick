import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPath, isRoleNoise, interestBreakdown, interestScore } from '../src/lib/rules.js';
import { mineBundle } from '../src/lib/mine.js';

test('admin pages without a placeholder are routes, not endpoints', () => {
  // This is the exact bug from the real nextlevelhub.xyz run.
  assert.equal(classifyPath('/admin/settings'), 'route');
  assert.equal(classifyPath('/admin/audit-log'), 'route');
  assert.equal(classifyPath('/admin/2fa'), 'route');
  assert.equal(classifyPath('/admin'), 'route');
});

test('api paths are still endpoints', () => {
  assert.equal(classifyPath('/api/conversations/v1/widget/restore'), 'endpoint');
  assert.equal(classifyPath('/graphql'), 'endpoint');
  assert.equal(classifyPath('/v2/users'), 'endpoint');
  assert.equal(classifyPath('/rest/orders'), 'endpoint');
  assert.equal(classifyPath('/_next/data/build/page.json'), 'endpoint');
});

test('a .json path reads as an endpoint even without an api prefix', () => {
  assert.equal(classifyPath('/data/config.json'), 'endpoint');
});

test('plain pages are routes', () => {
  assert.equal(classifyPath('/settings'), 'route');
  assert.equal(classifyPath('/dashboard'), 'route');
  assert.equal(classifyPath('/opportunities/{id}/edit'), 'route');
});

test('the mined bundle now labels admin pages as routes', () => {
  const bundle = `
    "/admin/settings";"/admin/audit-log";"/api/conversations/v1/restore";
    const r=[{path:"/admin/opportunities/:id/edit"}];
  `;
  const results = mineBundle(bundle);
  const kindOf = (v) => results.find((r) => r.value === v)?.kind;
  assert.equal(kindOf('/admin/settings'), 'route');
  assert.equal(kindOf('/admin/audit-log'), 'route');
  assert.equal(kindOf('/admin/opportunities/{id}/edit'), 'route');
  assert.equal(kindOf('/api/conversations/v1/restore'), 'endpoint');
});

test('bare generic role words are rejected as noise', () => {
  // "role: admin" ranking top was pure noise.
  assert.ok(isRoleNoise('admin'));
  assert.ok(isRoleNoise('user'));
  assert.ok(isRoleNoise('owner'));
  assert.ok(isRoleNoise('Role'));
});

test('structured role strings survive', () => {
  assert.ok(!isRoleNoise('ROLE_SUPERUSER'));
  assert.ok(!isRoleNoise('is_admin'));
  assert.ok(!isRoleNoise('isAdmin'));
  assert.ok(!isRoleNoise('org_owner'));
});

test('interest breakdown explains the score and sums to it', () => {
  const { score, reasons } = interestBreakdown('/api/internal/impersonate');
  assert.ok(score > 0);
  assert.equal(score, reasons.reduce((s, r) => s + r.weight, 0));
  assert.ok(reasons.some((r) => r.label.includes('impersonat')));
  assert.ok(reasons.some((r) => r.label.includes('internal')));
  // Sorted by weight, highest first.
  for (let i = 1; i < reasons.length; i++) {
    assert.ok(reasons[i - 1].weight >= reasons[i].weight);
  }
});

test('interestScore stays consistent with the breakdown', () => {
  for (const v of ['/admin/export', '/api/v0/legacy', 'GET /x']) {
    assert.equal(interestScore(v), interestBreakdown(v).score);
  }
});
