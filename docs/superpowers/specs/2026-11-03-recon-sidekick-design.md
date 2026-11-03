# Recon Sidekick — Design

Date: 2026-11-03
Status: approved, v1 in implementation

## Problem

Manual bug bounty tooling is stateless. Burp's sitemap, endpoint scrapers, and DOM
analysis tools all show the current session. Nothing keeps a durable, personal record
of a target across months, and nothing surfaces the gap between the attack surface an
app *declares* and the surface a hunter has *actually exercised*.

Two consequences:

1. Returning to a target after weeks means re-exploring from zero, with no signal about
   what the developers shipped in the interim. New code is under-tested code.
2. The highest-value list in manual hunting — endpoints and routes present in the client
   bundle that the hunter has never called — is not produced by any existing tool.

## What it is

A Manifest V3 Chrome extension that passively observes normal browsing of explicitly
armed targets, builds a local durable record of each target's client surface, and
presents two views that do not exist in current tooling:

- **What's new since last time** — per-target diff across sessions: new endpoints,
  new routes, changed bundle hashes, new feature flags, new role strings.
- **Declared but never reached** — surface mined from the client bundle, minus surface
  the runtime observed being exercised.

It is a notebook, not a scanner. It issues no requests of its own against a target.

## Non-goals (v1)

- Active scanning, fuzzing, or any extension-originated request to a target.
- Cross-machine or cross-profile sync. Storage is local only.
- Service worker and WebSocket traffic observation. Stated blind spots.
- AST-level bundle analysis. v1 is pattern mining (see Approach).

## Approach

The "reached" half requires runtime instrumentation — there is no alternative. A content
script in the page's MAIN world wraps `fetch` and `XMLHttpRequest` and listens to
`pushState`/`popstate`.

The "declared" half was chosen among three options:

| Option | Precision | Cost | Verdict |
|---|---|---|---|
| A. Pattern mining over fetched JS | Low-moderate, noisy | Days | **Chosen for v1** |
| B. AST parsing with chunk-map resolution | High | 5-10x A | Deferred |
| C. Framework-aware runtime route extraction | Highest where it works | Per-framework, brittle | Rejected for v1 |

Rationale: the diff engine and timeline are where the novelty lives, and they are
identical regardless of extraction method. A noisy-but-dismissible declared list still
produces a view that does not exist today. Precision work is deferred until real hunting
shows which noise actually costs time.

## Architecture

Five components.

**Scope store** — armed programs (name + host patterns, e.g. `*.target.com`) in
`chrome.storage.local`. Every component gates on it: unarmed host means the pipeline
never starts. Host permissions are requested at arm time via `optional_host_permissions`,
and content scripts are registered dynamically per armed origin rather than declared
broadly in the manifest.

**Page agent** — MAIN-world content script, registered only for armed origins. Wraps
`fetch` and `XMLHttpRequest`; listens to history events. Records that a call occurred and
to where. Never reads bodies or header values. Forwards observations by `postMessage` to
an isolated-world relay, which passes them to the service worker.

**Collector** — service worker. Normalizes, dedupes, and writes to IndexedDB.

**Bundle miner** — service worker. On seeing a JS asset for an armed host, fetches from
cache, hashes it, runs the rule pack, records candidates as `source: "mined"`.

*Deviation from original design:* mining runs in the service worker, not an offscreen
document. Regex over a multi-megabyte bundle is a few hundred milliseconds; the extra
component and message plumbing is not justified. The miner is a pure function and can be
relocated if profiling disagrees.

**UI** — popup for the glance (armed state, what's new count); full-page dashboard for
Timeline, Unreached, and Surface views.

### Normalization is load-bearing

`/api/users/8821` and `/api/users/9910` must collapse to `/api/users/{id}`, or the
timeline fills with noise and the product is worthless. Numeric segments, UUIDs, long
hex, base64-ish blobs, and date segments all collapse. Query strings retain parameter
*names*, never values. One raw example is retained per endpoint so a bad collapse stays
visible and recoverable.

### The diff is derived, not snapshotted

Rather than storing a full surface snapshot per visit, each observation is stored once
with `firstSeen`/`lastSeen`, and session boundaries are stored per target. "New since
last time" is then a query: observations whose `firstSeen` falls after the previous
session ended. No snapshot history, no unbounded storage growth, identical UX. Asset
hash changes are the one thing stored as an explicit event, because that is a mutation of
an existing row rather than a new row.

### Privacy invariants

Enforced in code, not merely intended:

- No request or response bodies.
- No header values, no cookie values.
- No query parameter values — names only.
- No data whatsoever from unarmed hosts.

The database holds shapes, not secrets.

## Data model

IndexedDB `recon-sidekick`:

- `programs` — `{id, name, hosts[], createdAt}`
- `observations` — `{id, programId, kind, value, raw, source, reached, dismissed,
  firstSeen, lastSeen, hits, interest}`; `kind` ∈ endpoint | route | flag | role | gqlop
- `assets` — `{id, programId, url, hash, firstSeen, lastSeen}`
- `events` — `{id, programId, at, type, detail}`
- `sessions` — `{id, programId, startedAt, endedAt}`
- `notes` — `{programId, text, updatedAt}`

Sessions close after a 30-minute idle gap.

## Views

**Timeline** — reverse-chronological sessions per target; each entry lists what appeared
and what changed during that session. The screen you open on returning to a target.

**Unreached** — the headline view. Mined surface the runtime never recorded reaching,
sorted by a crude interest heuristic (`admin`, `internal`, `impersonate`, `export`,
`debug`, version mismatches). Each row supports one-keystroke **dismiss** (noise) and
**mark reached** (already tested). Dismissals are per-target and permanent. This
mechanism is what makes a noisy mining approach livable, so it must be fast.

**Surface** — full flat searchable inventory, exportable to JSON and CSV, so observations
can feed external notes and wordlists.

Plus a free-text per-target notes field.

## Failure modes

- **Mining noise swamps Unreached.** The primary threat to usefulness. Mitigated by a
  default ignore set (asset extensions, i18n key shapes, CDN paths), one-keystroke
  dismiss, and interest sorting so good rows surface above the junk tail.
- **Page agent breaks the host app.** The wrapper reads and forwards only; it passes
  arguments and return values through untouched and swallows its own errors, so an
  extension fault can never surface as a page fault.
- **Over-collapsing normalization** loses real endpoints. Mitigated by retaining a raw
  example per endpoint.
- **Storage growth** on heavily-browsed targets. Mitigated by per-target size readout and
  a purge button.
- **Service worker / WebSocket blind spots.** Acknowledged, not papered over.

## Testing

- `normalize` and the mining rule pack are pure string functions — unit tested against a
  fixture corpus of saved bundles. This is where the bugs will be.
- The diff is a pure function over observations plus session boundaries — tested by
  seeding a synthetic history and asserting "new since last time".
- The page agent gets an integration test against a local fixture page, asserting both
  that it records calls and that it does not alter what the page receives.
- UI is exercised by hand.
