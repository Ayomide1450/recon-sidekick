// The dashboard: Timeline, Unreached, Surface, Notes.

import { send, ago, duration, formatBytes, el, clear, KIND_LABELS } from '../ui/bridge.js';

const KINDS = ['endpoint', 'route', 'flag', 'role', 'gqlop'];

const state = {
  programs: [],
  programId: null,
  tab: 'overview',
  kindFilter: null,
  search: '',
};

// Plain-language help per view. Mirrors VIEW_HELP in src/lib/summary.js; kept here too
// so the dashboard has no dependency on the background being reachable just to render
// its own help text.
const VIEW_HELP = {
  overview: 'A plain-language read of this target: how much of its surface you have covered, '
    + 'where the untested surface clusters, and what is worth looking at first.',
  unreached: 'Paths and identifiers the app\'s own JavaScript declares that your browsing '
    + 'never reached. Mined from the bundle, so some rows are noise — dismiss them and they '
    + 'stay gone. The score is a rough ranking, not a verdict; click it to see why.',
  timeline: 'What appeared and what changed on each visit, newest first. A long gap followed '
    + 'by new endpoints means the developers shipped code you have not seen.',
  surface: 'The complete inventory for this target — everything reached and everything mined. '
    + 'Searchable and exportable, for feeding into your own notes or wordlists.',
  notes: 'Free-text working notes, saved locally against this target.',
};

const TONE_LABEL = { hot: 'look here', warn: 'heads up', info: 'note' };

const nodes = {
  programList: document.getElementById('program-list'),
  programName: document.getElementById('program-name'),
  programHosts: document.getElementById('program-hosts'),
  headActions: document.getElementById('head-actions'),
  tabs: document.getElementById('tabs'),
  view: document.getElementById('view'),
  storage: document.getElementById('storage-line'),
};

const program = () => state.programs.find((p) => p.id === state.programId) || null;

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

async function renderSidebar() {
  clear(nodes.programList);

  if (!state.programs.length) {
    nodes.programList.append(
      el('div', { class: 'empty', style: 'padding:20px 10px;font-size:12px' },
        'No programs armed yet.'),
    );
    return;
  }

  for (const p of state.programs) {
    const button = el('button', {
      class: `program${p.id === state.programId ? ' active' : ''}${p.enabled ? '' : ' paused'}`,
      onclick: () => selectProgram(p.id),
    }, [
      el('div', { class: 'pname', text: p.name }),
      el('div', { class: 'pmeta', text: (p.hosts || []).join(', ') }),
    ]);
    nodes.programList.append(button);
  }
}

async function renderStorage() {
  try {
    if (!state.programId) { nodes.storage.textContent = ''; return; }
    const { usage } = await send('program:stats', { programId: state.programId });
    nodes.storage.textContent = usage ? `storage: ${formatBytes(usage.usage)}` : '';
  } catch {
    nodes.storage.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader() {
  const p = program();
  clear(nodes.headActions);
  clear(nodes.tabs);

  if (!p) {
    nodes.programName.textContent = 'No program selected';
    nodes.programHosts.textContent = '';
    return;
  }

  nodes.programName.textContent = p.name;
  nodes.programHosts.textContent = (p.hosts || []).join('  ');

  nodes.headActions.append(
    el('button', {
      class: 'ghost',
      text: p.enabled ? 'Pause recording' : 'Resume recording',
      title: p.enabled
        ? 'Stop recording this program without deleting its history'
        : 'Start recording this program again',
      onclick: async () => {
        await send('programs:update', { id: p.id, patch: { enabled: !p.enabled } });
        await reload();
      },
    }),
    el('button', {
      class: 'danger',
      text: 'Delete',
      onclick: async () => {
        if (!confirm(`Delete "${p.name}" and all of its recorded history? This cannot be undone.`)) return;
        await send('program:purge', { programId: p.id });
        await send('programs:remove', { id: p.id });
        state.programId = null;
        await reload();
      },
    }),
  );

  for (const [key, label] of [
    ['overview', 'Overview'],
    ['unreached', 'Unreached'],
    ['timeline', 'Timeline'],
    ['surface', 'Surface'],
    ['notes', 'Notes'],
  ]) {
    nodes.tabs.append(
      el('button', {
        class: `tab${state.tab === key ? ' active' : ''}`,
        text: label,
        onclick: () => { state.tab = key; void renderView(); renderHeader(); },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Shared row rendering
// ---------------------------------------------------------------------------

function matchesFilters(obs) {
  if (state.kindFilter && obs.kind !== state.kindFilter) return false;
  if (state.search && !obs.value.toLowerCase().includes(state.search.toLowerCase())) return false;
  return true;
}

function observationRow(obs, { actions = true } = {}) {
  const row = el('div', {
    class: `obs${obs.reached ? ' reached' : ''}${obs.dismissed ? ' dismissed' : ''}`,
  }, [
    el('span', { class: `pill ${obs.kind}`, text: KIND_LABELS[obs.kind] || obs.kind }),
    el('span', {
      class: `val grow${obs.interest >= 4 ? ' hot' : ''}`,
      text: obs.value,
      title: obs.foundIn ? `found in ${obs.foundIn}` : obs.raw || obs.value,
    }),
    el('span', {
      class: `score${obs.reasons?.length ? ' explainable' : ''}`,
      text: obs.interest ? `+${obs.interest}` : '',
      title: obs.reasons?.length ? 'why this score?' : '',
      onclick: obs.reasons?.length ? (event) => toggleScoreWhy(event, obs) : undefined,
    }),
  ]);

  if (actions) {
    row.append(
      el('span', { class: 'obs-actions' }, [
        !obs.reached && el('button', {
          class: 'ghost',
          text: 'tested',
          title: 'Mark reached — I have tested this',
          onclick: async () => {
            await send('observation:flags', { id: obs.id, reached: true });
            await renderView();
          },
        }),
        el('button', {
          class: 'ghost',
          text: 'noise',
          title: 'Dismiss — this is not real surface',
          onclick: async () => {
            await send('observation:flags', { id: obs.id, dismissed: true });
            await renderView();
          },
        }),
      ]),
    );
  }

  return row;
}

/** Expand or collapse a small "why this score" panel under a row. */
function toggleScoreWhy(event, obs) {
  event.stopPropagation();
  const row = event.target.closest('.obs');
  const existing = row.nextElementSibling;
  if (existing?.classList.contains('why')) {
    existing.remove();
    return;
  }
  const panel = el('div', { class: 'why' }, [
    el('div', { class: 'why-head', text: `interest +${obs.interest}, because:` }),
    el('ul', {}, obs.reasons.map((reason) =>
      el('li', {}, [
        el('span', { class: 'why-weight', text: `+${reason.weight}` }),
        el('span', { text: reason.label }),
      ]),
    )),
    el('div', { class: 'why-foot faint', text: 'A ranking heuristic, not a verdict. Verify by hand.' }),
  ]);
  row.after(panel);
}

/** A dismissable help banner explaining what the current view is for. */
function helpBanner(key) {
  return el('div', { class: 'help' }, [
    el('span', { class: 'help-icon', text: '?' }),
    el('span', { class: 'grow', text: VIEW_HELP[key] || '' }),
  ]);
}

function filterToolbar(extra = []) {
  const search = el('input', {
    type: 'text',
    placeholder: 'filter…',
    value: state.search,
    spellcheck: 'false',
  });
  search.addEventListener('input', () => {
    state.search = search.value;
    void renderView();
  });

  const seg = el('div', { class: 'seg' }, [
    el('button', {
      class: state.kindFilter === null ? 'on' : '',
      text: 'all',
      onclick: () => { state.kindFilter = null; void renderView(); },
    }),
    ...KINDS.map((kind) =>
      el('button', {
        class: state.kindFilter === kind ? 'on' : '',
        text: KIND_LABELS[kind],
        onclick: () => { state.kindFilter = kind; void renderView(); },
      }),
    ),
  ]);

  return el('div', { class: 'toolbar' }, [search, seg, ...extra]);
}

function exportButton(rows, basename) {
  return el('button', {
    text: 'Export',
    title: 'Download as JSON',
    onclick: () => {
      const payload = rows.map(({ id, programId, sessionId, ...rest }) => rest);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = el('a', { href: url, download: `${basename}.json` });
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
  });
}

function copyButton(rows) {
  return el('button', {
    text: 'Copy paths',
    title: 'Copy one value per line, for wordlists and notes',
    onclick: async () => {
      await navigator.clipboard.writeText(rows.map((r) => r.value).join('\n'));
    },
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function renderOverview() {
  const s = await send('view:overview', { programId: state.programId });

  clear(nodes.view);
  nodes.view.append(helpBanner('overview'));

  if (!s.totals.all) {
    nodes.view.append(el('div', { class: 'empty' },
      'Nothing recorded yet. Browse this target and the overview will fill in.'));
    return;
  }

  // Coverage headline — the one number that frames everything else.
  if (s.coverage !== null) {
    nodes.view.append(
      el('div', { class: 'coverage' }, [
        el('div', { class: 'coverage-bar' }, [
          el('div', { class: 'coverage-fill', style: `width:${s.coverage}%` }),
        ]),
        el('div', { class: 'coverage-label' }, [
          el('span', { class: 'coverage-pct', text: `${s.coverage}%` }),
          el('span', { class: 'faint',
            text: ` of declared surface exercised — ${s.totals.unreached} paths still unreached` }),
        ]),
      ]),
    );
  }

  // Plain-language insights.
  if (s.insights.length) {
    nodes.view.append(
      el('div', { class: 'insights' }, s.insights.map((insight) =>
        el('div', { class: `insight ${insight.tone}` }, [
          el('span', { class: 'insight-tag', text: TONE_LABEL[insight.tone] || insight.tone }),
          el('span', { class: 'grow', text: insight.text }),
        ]),
      )),
    );
  }

  // Where the unreached surface clusters.
  if (s.clusters.length) {
    nodes.view.append(
      el('h3', { class: 'section-h', text: 'Where unreached surface clusters' }),
      el('div', { class: 'cluster-grid' }, s.clusters.map((cluster) =>
        el('button', {
          class: 'cluster',
          title: `Filter Unreached to /${cluster.segment}`,
          onclick: () => { state.tab = 'unreached'; state.search = cluster.segment; renderHeader(); void renderView(); },
        }, [
          el('span', { class: 'cluster-seg mono', text: `/${cluster.segment}` }),
          el('span', { class: 'cluster-count', text: String(cluster.count) }),
          cluster.maxInterest >= 4 ? el('span', { class: 'cluster-hot', text: '●' }) : null,
        ]),
      )),
    );
  }

  // The short list to start on.
  if (s.topFindings.length) {
    nodes.view.append(
      el('h3', { class: 'section-h', text: 'Start here' }),
      el('div', { class: 'rows' }, s.topFindings.map((obs) =>
        observationRow({ ...obs, reasons: undefined }, { actions: false }))),
      el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('button', { class: 'primary', text: 'Open the full Unreached list',
          onclick: () => { state.tab = 'unreached'; renderHeader(); void renderView(); } }),
      ]),
    );
  }
}

async function renderUnreached() {
  const all = await send('view:unreached', { programId: state.programId });
  const rows = all.filter(matchesFilters);

  clear(nodes.view);
  nodes.view.append(
    helpBanner('unreached'),
    filterToolbar([exportButton(rows, 'unreached'), copyButton(rows)]),
  );

  if (!rows.length) {
    nodes.view.append(el('div', { class: 'empty' },
      all.length
        ? 'Nothing matches that filter.'
        : 'Nothing unreached. Browse the target so there is a bundle to mine.'));
    return;
  }

  nodes.view.append(el('div', { class: 'rows' }, rows.map((obs) => observationRow(obs))));
}

async function renderTimeline() {
  const timeline = await send('view:timeline', { programId: state.programId });

  clear(nodes.view);

  if (!timeline.length) {
    nodes.view.append(el('div', { class: 'empty' }, 'No visits recorded yet.'));
    return;
  }

  nodes.view.append(helpBanner('timeline'), filterToolbar());

  for (const entry of timeline) {
    const appeared = entry.appeared.filter(matchesFilters);
    const counts = Object.entries(entry.counts)
      .map(([kind, n]) => `${n} ${KIND_LABELS[kind] || kind}`)
      .join(' · ');

    const head = el('div', { class: 'session-head' }, [
      el('span', { class: 'when', text: new Date(entry.startedAt).toLocaleString() }),
      entry.isFirstVisit
        ? el('span', { class: 'gap', text: 'first visit' })
        : el('span', { class: 'gap', text: `after ${duration(entry.gapSincePrevious)} away` }),
      el('span', { class: 'counts', text: counts }),
    ]);

    const bodyNodes = [];
    for (const change of entry.changes) {
      bodyNodes.push(
        el('div', { class: 'change' }, [
          el('span', { class: 'pill', text: 'changed' }),
          el('span', { class: 'grow truncate', text: change.detail, title: change.detail }),
          el('span', { class: 'hash', text: `${change.from} → ${change.to}` }),
        ]),
      );
    }
    for (const obs of appeared) bodyNodes.push(observationRow(obs));

    if (!bodyNodes.length) {
      bodyNodes.push(el('div', { class: 'session-empty', text: 'nothing new during this visit' }));
    }

    nodes.view.append(el('div', { class: 'session' }, [head, el('div', { class: 'session-body' }, bodyNodes)]));
  }
}

async function renderSurface() {
  const all = await send('view:surface', { programId: state.programId });
  const rows = all.filter(matchesFilters);
  const stats = await send('program:stats', { programId: state.programId });

  const reached = all.filter((o) => o.reached).length;
  const mined = all.filter((o) => o.source === 'mined').length;

  clear(nodes.view);
  nodes.view.append(
    el('div', { class: 'stats' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'n', text: String(all.length) }), el('div', { class: 'k', text: 'total' })]),
      el('div', { class: 'stat' }, [el('div', { class: 'n', text: String(reached) }), el('div', { class: 'k', text: 'reached' })]),
      el('div', { class: 'stat' }, [el('div', { class: 'n', text: String(mined) }), el('div', { class: 'k', text: 'mined' })]),
      el('div', { class: 'stat' }, [el('div', { class: 'n', text: String(stats.counts.sessions) }), el('div', { class: 'k', text: 'visits' })]),
      el('div', { class: 'stat' }, [el('div', { class: 'n', text: String(stats.counts.assets) }), el('div', { class: 'k', text: 'bundles' })]),
    ]),
    helpBanner('surface'),
    filterToolbar([exportButton(rows, 'surface'), copyButton(rows)]),
  );

  if (!rows.length) {
    nodes.view.append(el('div', { class: 'empty' }, 'Nothing recorded yet.'));
  } else {
    nodes.view.append(el('div', { class: 'rows' }, rows.map((obs) => observationRow(obs))));
  }

  nodes.view.append(
    el('div', { class: 'notice blind-spots' },
      'Blind spots in v1: requests made from a page\'s own service worker, and WebSocket '
      + 'traffic. Neither is observed, so neither appears here.'),
  );
}

async function renderNotes() {
  const note = await send('notes:get', { programId: state.programId });

  const area = el('textarea', { class: 'notes', placeholder: 'Findings in progress…' });
  area.value = note.text || '';

  const status = el('div', { class: 'faint', style: 'font-size:11px;margin-top:6px' },
    note.updatedAt ? `saved ${ago(note.updatedAt)}` : 'not saved yet');

  let timer = null;
  area.addEventListener('input', () => {
    status.textContent = 'saving…';
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      await send('notes:set', { programId: state.programId, text: area.value });
      status.textContent = 'saved just now';
    }, 600);
  });

  clear(nodes.view);
  nodes.view.append(helpBanner('notes'), area, status);
}

async function renderView() {
  if (!state.programId) {
    clear(nodes.view);
    nodes.view.append(el('div', { class: 'empty' },
      'Arm a target from the toolbar popup to get started.'));
    return;
  }

  try {
    if (state.tab === 'overview') await renderOverview();
    else if (state.tab === 'unreached') await renderUnreached();
    else if (state.tab === 'timeline') await renderTimeline();
    else if (state.tab === 'surface') await renderSurface();
    else if (state.tab === 'notes') await renderNotes();
  } catch (error) {
    clear(nodes.view);
    nodes.view.append(el('div', { class: 'notice error', text: String(error.message || error) }));
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

async function selectProgram(id) {
  state.programId = id;
  state.search = '';
  state.kindFilter = null;
  state.tab = 'overview';
  await renderSidebar();
  renderHeader();
  await renderView();
  await renderStorage();
}

async function reload() {
  state.programs = await send('programs:list');
  if (state.programId && !state.programs.some((p) => p.id === state.programId)) {
    state.programId = null;
  }
  if (!state.programId && state.programs.length) {
    state.programId = state.programs[0].id;
  }
  await renderSidebar();
  renderHeader();
  await renderView();
  await renderStorage();
}

async function main() {
  const requested = new URLSearchParams(location.search).get('program');
  state.programs = await send('programs:list');
  state.programId = requested && state.programs.some((p) => p.id === requested)
    ? requested
    : state.programs[0]?.id || null;

  await renderSidebar();
  renderHeader();
  await renderView();
  await renderStorage();
}

void main();
