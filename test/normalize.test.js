import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSegment,
  normalizePath,
  paramNames,
  normalizeEndpoint,
  normalizeRoute,
} from '../src/lib/normalize.js';

test('collapses identifier-shaped segments', () => {
  assert.equal(normalizeSegment('8821'), '{id}');
  assert.equal(normalizeSegment('550e8400-e29b-41d4-a716-446655440000'), '{uuid}');
  assert.equal(normalizeSegment('2026-11-03'), '{date}');
  assert.equal(normalizeSegment('a3f91c8d2e7b4a90'), '{hash}');
  assert.equal(normalizeSegment('user_88211'), '{id}');
  assert.equal(normalizeSegment('ORD-00014922'), '{id}');
});

test('leaves stable route names alone', () => {
  assert.equal(normalizeSegment('users'), 'users');
  assert.equal(normalizeSegment('api'), 'api');
  assert.equal(normalizeSegment('v2'), 'v2');
  assert.equal(normalizeSegment('bulk-refund'), 'bulk-refund');
  assert.equal(normalizeSegment('impersonate'), 'impersonate');
});

test('the whole point: different ids collapse to one identity', () => {
  const a = normalizeEndpoint('https://app.target.com/api/users/8821/orders/41');
  const b = normalizeEndpoint('https://app.target.com/api/users/9910/orders/77');
  assert.equal(a.value, b.value);
  assert.equal(a.value, 'GET app.target.com/api/users/{id}/orders/{id}');
});

test('method is part of endpoint identity', () => {
  const get = normalizeEndpoint('https://x.com/api/orders', { method: 'GET' });
  const post = normalizeEndpoint('https://x.com/api/orders', { method: 'post' });
  assert.equal(get.value, 'GET x.com/api/orders');
  assert.equal(post.value, 'POST x.com/api/orders');
  assert.notEqual(get.value, post.value);
});

test('query parameter names are kept, values are never kept', () => {
  assert.deepEqual(paramNames('?token=supersecret&id=5'), ['id', 'token']);
  const result = normalizeEndpoint('https://x.com/api/me?token=supersecret&id=5');
  assert.equal(result.value, 'GET x.com/api/me?id&token');
  assert.ok(!JSON.stringify(result).includes('supersecret'));
});

test('param order does not affect identity', () => {
  const a = normalizeEndpoint('https://x.com/s?b=1&a=2');
  const b = normalizeEndpoint('https://x.com/s?a=9&b=8');
  assert.equal(a.value, b.value);
});

test('a raw example is retained but carries no query values', () => {
  const result = normalizeEndpoint('https://x.com/api/users/8821?secret=abc');
  assert.equal(result.raw, 'https://x.com/api/users/8821');
  assert.ok(!result.raw.includes('secret'));
});

test('trailing slashes and fragments do not fork identity', () => {
  const a = normalizeEndpoint('https://x.com/api/users/');
  const b = normalizeEndpoint('https://x.com/api/users#frag');
  assert.equal(a.value, b.value);
});

test('non-http schemes are rejected', () => {
  assert.equal(normalizeEndpoint('data:text/html,hi'), null);
  assert.equal(normalizeEndpoint('blob:https://x.com/abc'), null);
  assert.equal(normalizeEndpoint('chrome-extension://abc/x.js'), null);
  assert.equal(normalizeEndpoint('not a url at all'), null);
});

test('relative URLs resolve against the page base', () => {
  const result = normalizeEndpoint('/api/me', { base: 'https://app.target.com/dash' });
  assert.equal(result.value, 'GET app.target.com/api/me');
});

test('root path survives normalization', () => {
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizeEndpoint('https://x.com').value, 'GET x.com/');
});

test('mined route placeholders unify with visited route placeholders', () => {
  // This is what makes the unreached diff work: a route table entry and an actually
  // visited URL must compare equal.
  const declared = normalizeRoute('/admin/users/:userId/edit');
  const visited = normalizeRoute('https://app.target.com/admin/users/8821/edit');
  assert.equal(declared.value, visited.value);
  assert.equal(declared.value, '/admin/users/{id}/edit');
});

test('framework-specific route syntaxes unify', () => {
  assert.equal(normalizeRoute('/posts/[slug]').value, '/posts/{id}');
  assert.equal(normalizeRoute('/posts/:slug').value, '/posts/{id}');
  assert.equal(normalizeRoute('/files/*').value, '/files/{splat}');
});

test('bare paths with no origin still normalize', () => {
  const result = normalizeRoute('/admin/exports');
  assert.equal(result.value, '/admin/exports');
  assert.equal(result.raw, '/admin/exports');
});
