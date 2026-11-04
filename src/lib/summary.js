// Turns a target's raw observations into plain-language understanding.
//
// The dashboard shows rows; this module answers "so what?". It groups surface into
// meaningful clusters, surfaces the handful of findings worth looking at first, and
// explains what each view is for. Pure functions over observations — tested in
// test/summary.test.js.

import { reconcileReached } from './diff.js';

/** Group an endpoint/route path by its first meaningful segment. */
function topSegment(value) {
  const path = value.replace(/^[A-Z]+\s+/, '').replace(/^[^/]*/, '');
  const segments = path.split('/').filter(Boolean);
  // Skip a leading api-ish prefix so /api/admin/x groups under "admin", not "api".
  let index = 0;
  if (/^(?:api|rest|graphql|gql|v\d+|_api|rpc)$/i.test(segments[0] || '')) index = 1;
  if (/^v\d+$/i.test(segments[index] || '')) index += 1;
  return segments[index] || '(root)';
}

/**
 * Cluster unreached surface by its top path segment, so "47 rows" becomes
 * "/admin (31), /api/billing (6), /settings (4)".
 */
export function clusters(observations) {
  const groups = new Map();
  for (const obs of observations) {
    if (obs.kind !== 'endpoint' && obs.kind !== 'route') continue;
    const key = topSegment(obs.value);
    const group = groups.get(key) || { segment: key, count: 0, maxInterest: 0, items: [] };
    group.count += 1;
    group.maxInterest = Math.max(group.maxInterest, obs.interest || 0);
    group.items.push(obs);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.maxInterest - a.maxInterest || b.count - a.count || a.segment.localeCompare(b.segment),
  );
}

/**
 * A full picture of a target, assembled from its stored data. This is what the
 * dashboard's Overview renders and what drives the plain-language callouts.
 */
export function summarize({ observations = [], sessions = [], events = [], assets = [] } = {}) {
  const reconciled = reconcileReached(observations);
  const active = reconciled.filter((obs) => !obs.dismissed);

  const mined = active.filter((obs) => obs.source === 'mined');
  const reached = active.filter((obs) => obs.reached);
  const unreachedList = mined.filter((obs) => !obs.reached);

  const byKind = {};
  for (const obs of active) byKind[obs.kind] = (byKind[obs.kind] || 0) + 1;

  const coverage = mined.length
    ? Math.round((mined.filter((o) => o.reached).length / mined.length) * 100)
    : null;

  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const firstSeen = ordered[0]?.startedAt ?? null;
  const lastSeen = ordered.length
    ? (ordered[ordered.length - 1].endedAt ?? ordered[ordered.length - 1].startedAt)
    : null;

  const topFindings = [...unreachedList]
    .sort((a, b) => b.interest - a.interest || a.value.localeCompare(b.value))
    .slice(0, 8);

  return {
    totals: {
      all: active.length,
      reached: reached.length,
      unreached: unreachedList.length,
      mined: mined.length,
      sessions: sessions.length,
      bundles: assets.length,
      changes: events.length,
      dismissed: reconciled.filter((o) => o.dismissed).length,
    },
    byKind,
    coverage,
    firstSeen,
    lastSeen,
    clusters: clusters(unreachedList).slice(0, 8),
    topFindings,
    insights: buildInsights({ unreachedList, reached, events, coverage, byKind }),
  };
}

/**
 * Plain-language callouts. Each is something a hunter would actually want pointed out,
 * phrased as an observation plus why it matters — not a raw statistic.
 */
function buildInsights({ unreachedList, reached, events, coverage, byKind }) {
  const out = [];
  const has = (re) => unreachedList.some((o) => re.test(o.value.toLowerCase()));

  if (!reached.length && unreachedList.length) {
    out.push({
      tone: 'warn',
      text: 'Nothing is marked reached yet. Browse the target so the tool can tell apart '
        + 'surface you have tested from surface you have only mined.',
    });
  }

  if (coverage !== null && reached.length) {
    out.push({
      tone: 'info',
      text: `You have exercised about ${coverage}% of the surface this app's code declares. `
        + `The other ${100 - coverage}% is in the Unreached list.`,
    });
  }

  const adminUnreached = unreachedList.filter((o) => /\/admin(\/|$)|\badmin\b/.test(o.value.toLowerCase()));
  if (adminUnreached.length >= 3) {
    out.push({
      tone: 'hot',
      text: `${adminUnreached.length} admin-area paths are declared but unreached. These are `
        + 'the first place to check for missing authorization — can a normal user hit them?',
    });
  }

  if (has(/impersonat/)) {
    out.push({
      tone: 'hot',
      text: 'An impersonation endpoint is declared and unreached. Impersonation flows are a '
        + 'classic source of privilege-escalation and IDOR bugs.',
    });
  }

  if (has(/\/v0\b|\/v1\b/) && reached.some((o) => /\/v2\b|\/v3\b/.test(o.value))) {
    out.push({
      tone: 'hot',
      text: 'The app mostly uses a newer API version, but older-version endpoints are still '
        + 'declared and unreached. Legacy endpoints often lag on access-control fixes.',
    });
  }

  if (byKind.flag) {
    const debugFlags = unreachedList.filter((o) => o.kind === 'flag' && /debug|internal|test|beta|staff/.test(o.value.toLowerCase()));
    if (debugFlags.length) {
      out.push({
        tone: 'info',
        text: `${debugFlags.length} internal/debug feature flag${debugFlags.length === 1 ? '' : 's'} `
          + 'found in the bundle. If any can be toggled client-side, they may unlock hidden UI.',
      });
    }
  }

  if (events.length) {
    out.push({
      tone: 'info',
      text: `${events.length} bundle change${events.length === 1 ? '' : 's'} recorded. Each change `
        + 'is new code — re-check the Timeline for surface that appeared with it.',
    });
  }

  if (!out.length && unreachedList.length) {
    out.push({
      tone: 'info',
      text: 'Nothing jumped out automatically. Work down the Unreached list by interest score; '
        + 'the highest-scoring rows are the ones worth probing first.',
    });
  }

  return out;
}

/** Static copy explaining what each view is for. Rendered as help text in the UI. */
export const VIEW_HELP = {
  overview: 'A plain-language read of this target: how much of its surface you have covered, '
    + 'where the untested surface clusters, and anything worth looking at first.',
  unreached: 'Paths and identifiers the app\'s own JavaScript declares, that your browsing '
    + 'never reached. Mined by pattern-matching the bundle, so some rows are noise — dismiss '
    + 'them and they stay gone. The interest score is a rough ranking, not a verdict.',
  timeline: 'What appeared and what changed on each visit, newest first. A gap of weeks '
    + 'followed by new endpoints means the developers shipped code you have not seen.',
  surface: 'The complete inventory for this target — everything reached and everything mined. '
    + 'Searchable and exportable, for feeding into your own notes or wordlists.',
  notes: 'Free-text working notes, saved locally against this target.',
};
