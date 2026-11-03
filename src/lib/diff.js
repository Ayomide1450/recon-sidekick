// The diff engine: what is new since last time, and what was declared but never reached.
//
// These are the two views that justify the whole extension, and they are pure functions
// over stored observations plus session boundaries. No snapshots are kept — "new since
// last time" is derived from firstSeen timestamps against the previous session's end.
//
// Unit tested in test/diff.test.js.

/** Sessions close after this much inactivity. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * The cross-source comparison key.
 *
 * Runtime observations know the HTTP method and host ("GET app.x.com/api/users/{id}").
 * Mined observations know neither ("/api/users/{id}"). To decide whether a declared
 * endpoint was ever reached we have to compare on the path alone.
 */
export function pathKey(observation) {
  const value = String(observation?.value ?? '');
  if (!value) return '';
  // Strip a leading method verb.
  const withoutMethod = value.replace(/^[A-Z]+\s+/, '');
  // Strip a leading host, keeping the path.
  const slash = withoutMethod.indexOf('/');
  const path = slash === -1 ? withoutMethod : withoutMethod.slice(slash);
  // Drop the query-parameter-name suffix: reaching an endpoint with different params
  // still counts as reaching it.
  return path.split('?')[0];
}

/**
 * Mark mined observations as reached when a runtime observation covered the same path.
 *
 * Returns a new array; does not mutate the input. The `reached` flag already stored on
 * a record is preserved (the user may have set it manually via "mark reached").
 */
export function reconcileReached(observations) {
  const reachedPaths = new Set();
  for (const obs of observations) {
    if (obs.source === 'runtime') reachedPaths.add(pathKey(obs));
  }
  return observations.map((obs) => {
    if (obs.source === 'runtime') return { ...obs, reached: true };
    if (obs.reached) return { ...obs };
    return { ...obs, reached: reachedPaths.has(pathKey(obs)) };
  });
}

/**
 * The headline view: declared but never reached, most interesting first.
 */
export function unreached(observations, { kinds = null } = {}) {
  return reconcileReached(observations)
    .filter((obs) => {
      if (obs.dismissed) return false;
      if (obs.reached) return false;
      if (obs.source !== 'mined') return false;
      if (kinds && !kinds.includes(obs.kind)) return false;
      return true;
    })
    .sort((a, b) => {
      if (b.interest !== a.interest) return b.interest - a.interest;
      // Newer surface first among equally interesting rows — fresh code is the point.
      if (b.firstSeen !== a.firstSeen) return b.firstSeen - a.firstSeen;
      return a.value.localeCompare(b.value);
    });
}

/**
 * Determine the session immediately preceding the given one.
 * Sessions are assumed sorted ascending by startedAt.
 */
export function previousSession(sessions, currentId) {
  const index = sessions.findIndex((s) => s.id === currentId);
  if (index <= 0) return null;
  return sessions[index - 1];
}

/**
 * Observations first seen strictly after a timestamp.
 */
export function newSince(observations, since) {
  return observations
    .filter((obs) => !obs.dismissed && obs.firstSeen > since)
    .sort((a, b) => b.interest - a.interest || a.value.localeCompare(b.value));
}

/**
 * Build the Timeline: one entry per session, newest first, listing what appeared and
 * what changed while you were there.
 *
 * @param {Array} sessions - ascending by startedAt
 * @param {Array} observations
 * @param {Array} events - asset hash changes and similar mutations
 */
export function buildTimeline(sessions, observations, events = []) {
  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);

  return ordered
    .map((session, index) => {
      const previous = index > 0 ? ordered[index - 1] : null;
      // A session's window extends from its start to its end. Observations recorded in
      // that window are what "appeared" during the visit.
      const from = session.startedAt;
      const to = session.endedAt ?? Date.now();

      const appeared = observations.filter(
        (obs) => !obs.dismissed && obs.firstSeen >= from && obs.firstSeen <= to,
      );
      const changes = events.filter((event) => event.at >= from && event.at <= to);

      const byKind = {};
      for (const obs of appeared) {
        byKind[obs.kind] = (byKind[obs.kind] || 0) + 1;
      }

      return {
        sessionId: session.id,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        // Gap since the previous visit — this is the "last seen 23 days ago" line.
        gapSincePrevious: previous ? session.startedAt - (previous.endedAt ?? previous.startedAt) : null,
        isFirstVisit: !previous,
        counts: byKind,
        appeared: appeared.sort((a, b) => b.interest - a.interest),
        changes,
      };
    })
    .reverse();
}

/**
 * The popup glance: a one-line summary of what changed since the last completed visit.
 */
export function glance(sessions, observations, events = []) {
  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  if (!ordered.length) {
    return { isFirstVisit: true, newCount: 0, changeCount: 0, lastSeen: null, byKind: {} };
  }

  const current = ordered[ordered.length - 1];
  const previous = ordered.length > 1 ? ordered[ordered.length - 2] : null;
  const since = previous ? (previous.endedAt ?? previous.startedAt) : 0;

  const fresh = newSince(observations, since);
  const changes = events.filter((event) => event.at > since);

  const byKind = {};
  for (const obs of fresh) byKind[obs.kind] = (byKind[obs.kind] || 0) + 1;

  return {
    isFirstVisit: !previous,
    newCount: fresh.length,
    changeCount: changes.length,
    lastSeen: previous ? (previous.endedAt ?? previous.startedAt) : null,
    currentSessionStarted: current.startedAt,
    byKind,
    top: fresh.slice(0, 5),
  };
}
