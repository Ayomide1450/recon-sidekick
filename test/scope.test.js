import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostMatchesPattern,
  programForHost,
  programForUrl,
  toMatchPatterns,
  validateHostPattern,
} from '../src/lib/scope.js';

test('exact host patterns match only that host', () => {
  assert.ok(hostMatchesPattern('target.com', 'target.com'));
  assert.ok(!hostMatchesPattern('app.target.com', 'target.com'));
  assert.ok(!hostMatchesPattern('nottarget.com', 'target.com'));
});

test('wildcard patterns match subdomains and the apex', () => {
  assert.ok(hostMatchesPattern('app.target.com', '*.target.com'));
  assert.ok(hostMatchesPattern('a.b.target.com', '*.target.com'));
  assert.ok(hostMatchesPattern('target.com', '*.target.com'));
  assert.ok(hostMatchesPattern('app.target.com', '.target.com'));
});

test('wildcard patterns do not match a suffix-colliding host', () => {
  // The classic bug: "evil-target.com" must not match "*.target.com".
  assert.ok(!hostMatchesPattern('eviltarget.com', '*.target.com'));
  assert.ok(!hostMatchesPattern('evil-target.com', '*.target.com'));
  assert.ok(!hostMatchesPattern('target.com.evil.net', '*.target.com'));
});

test('matching is case and trailing-dot insensitive', () => {
  assert.ok(hostMatchesPattern('APP.Target.COM', '*.target.com'));
  assert.ok(hostMatchesPattern('app.target.com.', '*.target.com'));
});

const programs = [
  { id: 'p1', name: 'Target', enabled: true, hosts: ['*.target.com'] },
  { id: 'p2', name: 'Other', enabled: true, hosts: ['other.io', 'api.other.io'] },
  { id: 'p3', name: 'Paused', enabled: false, hosts: ['*.paused.com'] },
];

test('resolves the program covering a host', () => {
  assert.equal(programForHost('app.target.com', programs).id, 'p1');
  assert.equal(programForHost('api.other.io', programs).id, 'p2');
});

test('unarmed hosts resolve to nothing — the core privacy gate', () => {
  assert.equal(programForHost('mybank.com', programs), null);
  assert.equal(programForHost('mail.google.com', programs), null);
});

test('a disabled program does not arm its hosts', () => {
  assert.equal(programForHost('app.paused.com', programs), null);
});

test('programForUrl rejects non-http schemes', () => {
  assert.equal(programForUrl('https://app.target.com/x', programs).id, 'p1');
  assert.equal(programForUrl('chrome://settings', programs), null);
  assert.equal(programForUrl('file:///c:/x', programs), null);
  assert.equal(programForUrl('garbage', programs), null);
});

test('match patterns cover apex and subdomains', () => {
  assert.deepEqual(toMatchPatterns('*.target.com'), [
    '*://target.com/*',
    '*://*.target.com/*',
  ]);
  assert.deepEqual(toMatchPatterns('target.com'), ['*://target.com/*']);
});

test('validation rejects URLs, paths and overly broad patterns', () => {
  assert.equal(validateHostPattern('*.target.com'), null);
  assert.equal(validateHostPattern('target.com'), null);
  assert.ok(validateHostPattern('https://target.com'));
  assert.ok(validateHostPattern('target.com/api'));
  assert.ok(validateHostPattern(''));
  assert.ok(validateHostPattern('*.com'));
  assert.ok(validateHostPattern('localhost'));
});
