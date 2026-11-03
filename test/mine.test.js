import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mineBundle, hashText } from '../src/lib/mine.js';
import { isNoise, isFlagNoise, interestScore } from '../src/lib/rules.js';

const values = (results, kind) =>
  results.filter((r) => r.kind === kind).map((r) => r.value);

test('mines api endpoints out of a minified-ish bundle', () => {
  const bundle = `
    var e=function(){return n.get("/api/v2/users")},
        t=function(){return n.post("/api/internal/impersonate")},
        r=fetch("/api/v2/billing/invoices");
  `;
  const endpoints = values(mineBundle(bundle), 'endpoint');
  assert.ok(endpoints.includes('/api/v2/users'));
  assert.ok(endpoints.includes('/api/internal/impersonate'));
  assert.ok(endpoints.includes('/api/v2/billing/invoices'));
});

test('distinguishes client routes from api endpoints', () => {
  const bundle = `
    const routes=[{path:"/admin/users/:userId"},{path:"/settings"}];
    const api="/api/users/:id";
  `;
  const results = mineBundle(bundle);
  // Parameterised non-api path is a route.
  assert.ok(values(results, 'route').includes('/admin/users/{id}'));
  // Parameterised /api path stays an endpoint despite the placeholder.
  assert.ok(values(results, 'endpoint').includes('/api/users/{id}'));
});

test('mines graphql operations', () => {
  const bundle = `
    const Q = gql\`query GetCurrentUser { me { id } }\`;
    const M = gql\`mutation BulkRefundOrders($ids:[ID!]!) { ok }\`;
  `;
  const ops = values(mineBundle(bundle), 'gqlop');
  assert.ok(ops.includes('GetCurrentUser'));
  assert.ok(ops.includes('BulkRefundOrders'));
});

test('mines feature flags and role strings', () => {
  const bundle = `
    if(flags["billing.bulk_refund"]&&flags["admin.export_all"]){}
    var roles=["ROLE_SUPERUSER","is_admin"];
  `;
  const results = mineBundle(bundle);
  const flags = values(results, 'flag');
  assert.ok(flags.includes('billing.bulk_refund'));
  assert.ok(flags.includes('admin.export_all'));
  const roles = values(results, 'role');
  assert.ok(roles.some((r) => r.includes('SUPERUSER') || r.includes('admin')));
});

test('rejects asset paths as noise', () => {
  for (const path of [
    '/static/js/main.a81f.js',
    '/assets/logo.svg',
    '/_next/static/chunks/42.js',
    '/images/hero.png',
    '/fonts/inter.woff2',
    '/main.css',
  ]) {
    assert.ok(isNoise(path), `${path} should be noise`);
  }
});

test('rejects non-path strings as noise', () => {
  for (const value of [
    'api/users',              // no leading slash
    '//cdn.example.com/x',    // protocol-relative
    'https://x.com/api',      // absolute URL
    '/a/b',                   // single-char segments: minifier artifacts
    '/ has space',
    '',
  ]) {
    assert.ok(isNoise(value), `${JSON.stringify(value)} should be noise`);
  }
});

test('accepts real-looking endpoints', () => {
  for (const path of [
    '/api/v2/users',
    '/admin/exports',
    '/api/internal/impersonate',
    '/graphql',
  ]) {
    assert.ok(!isNoise(path), `${path} should survive`);
  }
});

test('flag filter rejects the usual false positives', () => {
  for (const value of [
    'main.a81f.js',
    '1.2.3',
    'text/html',
    'button.label',
    '--color-primary',
    'utf-8',
    'word',
  ]) {
    assert.ok(isFlagNoise(value), `${value} should be rejected`);
  }
  assert.ok(!isFlagNoise('billing.bulk_refund'));
  assert.ok(!isFlagNoise('admin.export_all'));
});

test('interest scoring ranks dangerous surface above boring surface', () => {
  const spicy = interestScore('/api/internal/impersonate');
  const boring = interestScore('/api/v2/profile');
  assert.ok(spicy > boring, `${spicy} should beat ${boring}`);

  assert.ok(interestScore('DELETE /api/admin/users/{id}') > interestScore('GET /api/users/{id}'));
  assert.ok(interestScore('/api/v0/legacy') > interestScore('/api/v2/current'));
});

test('mining is deduplicated', () => {
  const bundle = '"/api/me";"/api/me";"/api/me"';
  const endpoints = values(mineBundle(bundle), 'endpoint');
  assert.equal(endpoints.filter((e) => e === '/api/me').length, 1);
});

test('mining handles empty and non-string input without throwing', () => {
  assert.deepEqual(mineBundle(''), []);
  assert.deepEqual(mineBundle(null), []);
  assert.deepEqual(mineBundle(undefined), []);
});

test('repeated mining gives identical results (no regex lastIndex leakage)', () => {
  const bundle = '"/api/v2/users";"/api/v2/orders"';
  const first = mineBundle(bundle);
  const second = mineBundle(bundle);
  assert.deepEqual(first, second);
});

test('hashing detects bundle changes and is stable', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  // Same character multiset, different content — the length mix-in is not enough alone,
  // but FNV ordering handles it.
  assert.notEqual(hashText('ab'), hashText('ba'));
});
