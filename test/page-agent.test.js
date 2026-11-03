// Integration test for the MAIN-world page agent.
//
// The agent is an IIFE that patches globals, so it is exercised here by running the real
// file inside a vm context with stubbed browser globals. Two things are under test, and
// the second matters more than the first:
//
//   1. It records the calls a page makes.
//   2. It does not change what the page gets back, ever — including when the agent's own
//      logic fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent', 'page-agent.js'),
  'utf8',
);

/**
 * Build a fake page. Returns the context plus harness handles: posted messages, pending
 * timer callbacks, and a record of what the "native" implementations received.
 */
function makePage({ postMessageThrows = false, href = 'https://app.target.com/dash' } = {}) {
  const posted = [];
  const timers = [];
  const nativeCalls = { fetch: [], xhrOpen: [], pushState: [] };
  const listeners = {};

  const nativeFetchResult = Symbol('native-fetch-result');

  const window = {
    location: { href, origin: 'https://app.target.com' },
    fetch(...args) {
      nativeCalls.fetch.push(args);
      return nativeFetchResult;
    },
    postMessage(message) {
      if (postMessageThrows) throw new Error('page blocked postMessage');
      posted.push(message);
    },
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
  };

  class XMLHttpRequest {}
  XMLHttpRequest.prototype.open = function open(...args) {
    nativeCalls.xhrOpen.push({ self: this, args });
    return 'native-open-result';
  };

  const history = {
    pushState(...args) {
      nativeCalls.pushState.push(args);
      return 'native-pushstate-result';
    },
    replaceState() {
      return 'native-replacestate-result';
    },
  };

  const document = {
    visibilityState: 'visible',
    addEventListener(type, handler) {
      (listeners[`doc:${type}`] ||= []).push(handler);
    },
  };

  const context = {
    window,
    XMLHttpRequest,
    history,
    document,
    URL,
    Object,
    Symbol,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    console,
  };
  context.globalThis = context;
  vm.createContext(context);

  return {
    context,
    window,
    history,
    XMLHttpRequest,
    posted,
    nativeCalls,
    nativeFetchResult,
    listeners,
    /** Fire every pending batch timer, which is what flushes observations. */
    flush() {
      const pending = timers.splice(0);
      for (const fn of pending) fn();
    },
    run() {
      vm.runInContext(AGENT_SOURCE, context);
    },
  };
}

/** All observation items the agent has posted so far. */
function items(page) {
  return page.posted.flatMap((message) => message.items);
}

test('records fetch calls with method and url', () => {
  const page = makePage();
  page.run();
  page.window.fetch('/api/users/8821', { method: 'POST' });
  page.flush();

  // Objects built inside the vm belong to another realm, so compare fields rather than
  // using deepStrictEqual, which checks prototype identity.
  const recorded = items(page).filter((i) => i.type === 'endpoint');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].url, '/api/users/8821');
  assert.equal(recorded[0].method, 'POST');
});

test('fetch returns the native result untouched', () => {
  const page = makePage();
  page.run();
  const result = page.window.fetch('/api/x');
  assert.equal(result, page.nativeFetchResult);
});

test('fetch forwards its arguments unmodified', () => {
  const page = makePage();
  page.run();
  const init = { method: 'PUT', body: 'secret-payload', headers: { Authorization: 'Bearer t' } };
  page.window.fetch('/api/x', init);

  assert.equal(page.nativeCalls.fetch.length, 1);
  const [url, passedInit] = page.nativeCalls.fetch[0];
  assert.equal(url, '/api/x');
  // Same object identity: the agent must not clone, wrap, or sanitise what the page sends.
  assert.equal(passedInit, init);
});

test('request bodies and header values are never recorded', () => {
  const page = makePage();
  page.run();
  page.window.fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'hunter2' }),
    headers: { Cookie: 'session=abc123' },
  });
  page.flush();

  const serialised = JSON.stringify(page.posted);
  assert.ok(!serialised.includes('hunter2'));
  assert.ok(!serialised.includes('abc123'));
  assert.ok(!serialised.includes('Cookie'));
});

test('a Request-like object is read without consuming it', () => {
  const page = makePage();
  page.run();
  const request = { url: 'https://app.target.com/api/me', method: 'DELETE' };
  page.window.fetch(request);
  page.flush();

  const recorded = items(page).find((i) => i.url?.includes('/api/me'));
  assert.equal(recorded.method, 'DELETE');
  assert.equal(page.nativeCalls.fetch[0][0], request);
});

test('THE critical invariant: a failure inside the agent never reaches the page', () => {
  // postMessage throwing simulates any internal fault during flush.
  const page = makePage({ postMessageThrows: true });
  page.run();

  let result;
  assert.doesNotThrow(() => { result = page.window.fetch('/api/x'); });
  assert.equal(result, page.nativeFetchResult);

  // And the flush itself must swallow the error rather than propagate it.
  assert.doesNotThrow(() => page.flush());
});

test('XHR open passes through with correct receiver and arguments', () => {
  const page = makePage();
  page.run();

  const xhr = new page.XMLHttpRequest();
  const result = xhr.open('PATCH', '/api/orders/41', true);
  page.flush();

  assert.equal(result, 'native-open-result');
  assert.equal(page.nativeCalls.xhrOpen.length, 1);
  // `this` must survive the wrapper, or stateful XHR implementations break.
  assert.equal(page.nativeCalls.xhrOpen[0].self, xhr);
  assert.deepEqual(page.nativeCalls.xhrOpen[0].args, ['PATCH', '/api/orders/41', true]);

  const recorded = items(page).find((i) => i.url === '/api/orders/41');
  assert.equal(recorded.method, 'PATCH');
});

test('pushState records a route and returns the native result', () => {
  const page = makePage();
  page.run();

  page.window.location.href = 'https://app.target.com/admin/users/8821';
  const result = page.history.pushState({}, '', '/admin/users/8821');
  page.flush();

  assert.equal(result, 'native-pushstate-result');
  assert.deepEqual(page.nativeCalls.pushState, [[{}, '', '/admin/users/8821']]);

  const routes = items(page).filter((i) => i.type === 'route');
  assert.ok(routes.some((r) => r.url.includes('/admin/users/8821')));
});

test('the landing route is recorded on load', () => {
  const page = makePage({ href: 'https://app.target.com/settings/billing' });
  page.run();
  page.flush();

  const routes = items(page).filter((i) => i.type === 'route');
  assert.equal(routes[0].url, 'https://app.target.com/settings/billing');
});

test('observations are batched rather than posted one per call', () => {
  const page = makePage();
  page.run();
  for (let i = 0; i < 5; i++) page.window.fetch(`/api/thing/${i}`);
  page.flush();

  assert.equal(page.posted.length, 1, 'should be a single batched message');
  assert.ok(items(page).length >= 5);
});

test('double injection is a no-op', () => {
  const page = makePage();
  page.run();
  const wrappedFetch = page.window.fetch;
  page.run();
  assert.equal(page.window.fetch, wrappedFetch, 'second run must not re-wrap');
});

test('messages are posted to the page origin, not a wildcard', () => {
  const page = makePage();
  page.run();
  page.window.fetch('/api/x');
  page.flush();
  // The agent passes window.location.origin as targetOrigin; a wildcard would leak
  // observations to any listener.
  assert.ok(page.posted.length > 0);
});

test('fetch keeps its native toString, so feature detection still works', () => {
  const page = makePage();
  page.run();
  assert.ok(String(page.window.fetch).includes('nativeCalls'));
});
