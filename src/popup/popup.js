// The popup: the glance. "Is this armed, and what is new since last time."
//
// Arming happens here because requesting host permissions requires a user gesture in an
// extension page — the service worker cannot do it.

import { send, ago, el, clear, KIND_LABELS } from '../ui/bridge.js';
import { toMatchPatterns, validateHostPattern } from '../lib/scope.js';

const scopeLine = document.getElementById('scope-line');
const body = document.getElementById('body');

document.getElementById('open-dashboard').addEventListener('click', () => {
  void openDashboard();
});

async function openDashboard(programId) {
  const url = chrome.runtime.getURL(
    `src/dashboard/dashboard.html${programId ? `?program=${encodeURIComponent(programId)}` : ''}`,
  );
  await chrome.tabs.create({ url });
  window.close();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function suggestHost(hostname) {
  // Offer the registrable-ish parent as a wildcard: hunters almost always want the whole
  // domain, not the one subdomain they happen to be looking at.
  const parts = hostname.split('.');
  if (parts.length <= 2) return `*.${hostname}`;
  return `*.${parts.slice(-2).join('.')}`;
}

function renderArmForm(hostname) {
  const suggestion = suggestHost(hostname);

  const nameInput = el('input', { type: 'text', placeholder: 'Program name', value: hostname.replace(/^www\./, '') });
  const hostInput = el('input', { type: 'text', value: suggestion, spellcheck: 'false', class: 'mono' });
  const status = el('div', { class: 'hint' });
  const armButton = el('button', { class: 'primary', text: 'Arm this program' });

  armButton.addEventListener('click', () => {
    const hosts = hostInput.value.split(',').map((h) => h.trim()).filter(Boolean);

    // Validate and build the origin list synchronously. chrome.permissions.request only
    // works while the user gesture is still live, so nothing may be awaited before it —
    // a message round-trip here would make the prompt silently fail to appear.
    if (!hosts.length) {
      status.className = 'notice error';
      status.textContent = 'Enter at least one host';
      return;
    }
    for (const host of hosts) {
      const error = validateHostPattern(host);
      if (error) {
        status.className = 'notice error';
        status.textContent = `${host}: ${error}`;
        return;
      }
    }

    const origins = [...new Set(hosts.flatMap(toMatchPatterns))];

    armButton.disabled = true;
    status.className = 'hint';
    status.textContent = 'requesting permission…';

    chrome.permissions.request({ origins }, async (granted) => {
      try {
        if (!granted) {
          status.className = 'hint';
          status.textContent = 'permission declined — nothing was armed';
          armButton.disabled = false;
          return;
        }

        const program = await send('programs:add', { name: nameInput.value, hosts });
        await send('programs:sync');

        status.textContent = 'armed — reloading to start recording';
        // The agent is now registered, but registration does not inject into tabs that
        // are already open. A reload is what actually starts recording this page.
        const tab = await activeTab();
        if (tab?.id) await chrome.tabs.reload(tab.id);
        await openDashboard(program.id);
      } catch (error) {
        status.className = 'notice error';
        status.textContent = String(error.message || error);
        armButton.disabled = false;
      }
    });
  });

  return el('div', {}, [
    el('div', { class: 'notice' }, 'Not armed. Nothing on this host is being recorded.'),
    el('div', { class: 'arm-form' }, [
      el('label', { text: 'Program' }),
      nameInput,
      el('label', { text: 'Hosts (comma separated)' }),
      hostInput,
      el('div', { class: 'hint' }, 'Arming requests browser permission for these hosts only.'),
      armButton,
      status,
    ]),
  ]);
}

function renderGlance(program, data) {
  const nodes = [];

  if (data.isFirstVisit) {
    nodes.push(
      el('div', { class: 'headline none', text: 'First visit — building a baseline' }),
      el('div', { class: 'sub', text: 'Come back later and this shows what changed.' }),
    );
  } else if (data.newCount === 0 && data.changeCount === 0) {
    nodes.push(
      el('div', { class: 'headline none', text: 'Nothing new since last time' }),
      el('div', { class: 'sub', text: `Last visit ${ago(data.lastSeen)}.` }),
    );
  } else {
    nodes.push(
      el('div', { class: 'headline' }, [
        `+${data.newCount} `,
        el('span', { class: 'unit', text: data.newCount === 1 ? 'new thing' : 'new things' }),
      ]),
      el('div', {
        class: 'sub',
        text: `since your last visit ${ago(data.lastSeen)}`
          + (data.changeCount ? ` · ${data.changeCount} bundle change${data.changeCount === 1 ? '' : 's'}` : ''),
      }),
    );

    const kinds = Object.entries(data.byKind);
    if (kinds.length) {
      nodes.push(
        el('div', { class: 'row wrap kinds' },
          kinds.map(([kind, count]) =>
            el('span', { class: `pill ${kind}`, text: `${count} ${KIND_LABELS[kind] || kind}` }),
          ),
        ),
      );
    }

    if (data.top?.length) {
      nodes.push(
        el('div', { class: 'top-list' },
          data.top.map((obs) =>
            el('div', { class: 'item' }, [
              el('span', { class: `pill ${obs.kind}`, text: KIND_LABELS[obs.kind] || obs.kind }),
              el('span', { class: `val grow${obs.interest >= 4 ? ' hot' : ''}`, text: obs.value, title: obs.value }),
            ]),
          ),
        ),
      );
    }
  }

  nodes.push(
    el('div', { class: 'row actions' }, [
      el('button', {
        class: 'primary grow',
        text: 'Open dashboard',
        onclick: () => void openDashboard(program.id),
      }),
    ]),
  );

  return el('div', {}, nodes);
}

async function main() {
  const tab = await activeTab();

  if (!tab?.url) {
    scopeLine.textContent = 'no page';
    clear(body);
    body.append(el('div', { class: 'empty', text: 'No active page.' }));
    return;
  }

  let hostname;
  try {
    const url = new URL(tab.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported');
    hostname = url.hostname;
  } catch {
    scopeLine.className = 'scope-line mono faint';
    scopeLine.textContent = 'not a web page';
    clear(body);
    body.append(el('div', { class: 'empty', text: 'Open a target in a normal tab.' }));
    return;
  }

  scopeLine.textContent = hostname;

  try {
    const program = await send('program:for-url', { url: tab.url });
    clear(body);

    if (!program) {
      scopeLine.className = 'scope-line mono unarmed';
      scopeLine.textContent = `${hostname} · not armed`;
      body.append(renderArmForm(hostname));
      return;
    }

    scopeLine.className = 'scope-line mono armed';
    scopeLine.textContent = `${hostname} · recording "${program.name}"`;

    const data = await send('view:glance', { programId: program.id });
    body.append(renderGlance(program, data));
  } catch (error) {
    clear(body);
    body.append(el('div', { class: 'notice error', text: String(error.message || error) }));
  }
}

void main();
