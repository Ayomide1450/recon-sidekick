# Privacy Policy — Recon Sidekick

Last updated: 3 November 2026

## Summary

Recon Sidekick stores everything locally in your own browser. It has no server, no
account, and no analytics. Nothing it records is transmitted anywhere.

## What the extension records

Only for hosts you have explicitly armed, and only while a program is enabled:

- URL **shapes** of requests the page makes — HTTP method, hostname, and path with
  identifier-like segments replaced by placeholders (`/api/users/{id}`)
- **Names** of query parameters (never their values)
- Client-side route paths you navigate to
- Content hashes of JavaScript files the page loads
- Strings pattern-matched from those JavaScript files: path-like literals, GraphQL
  operation names, feature-flag-like identifiers, and role-like identifiers
- Timestamps of your visits
- Any free-text notes you choose to type into the extension

## What the extension never records

- Request bodies or response bodies
- HTTP header values
- Cookies, tokens, or credentials of any kind
- Query parameter **values**
- Page content, form input, or keystrokes
- Anything at all from hosts you have not armed

These exclusions are enforced in code, in `src/background/collector.js` and
`src/agent/relay.js`, not merely stated as intent.

## Where data is stored

In your browser's local IndexedDB and `chrome.storage.local`, on your device. It is
never uploaded. The author has no ability to access it.

## Data sharing and sale

None. No data is transmitted off your device, so there is nothing to share, sell, or
transfer. There are no third-party services, SDKs, or analytics in this extension.

## Network activity

The extension makes exactly one kind of request: re-reading JavaScript files the page
already downloaded, from the browser cache, for armed hosts. It issues no requests to
any server operated by the author, and no requests to any URL the page did not already
load.

## Permissions

See [STORE-LISTING.md](STORE-LISTING.md) for a per-permission justification.

Host access is **optional** and requested at the moment you arm a program, for exactly
the hosts you entered. The extension declares no host permissions by default, and its
content scripts are registered dynamically only for granted origins.

## Deleting your data

Open the dashboard, select a program, and click **Delete** — this purges all observations,
sessions, events, and notes for that program. Removing the extension deletes everything.

## Changes

Material changes to this policy will be published in this file, which is versioned in
the public repository at https://github.com/Ayomide1450/recon-sidekick.

## Contact

Open an issue at https://github.com/Ayomide1450/recon-sidekick/issues
