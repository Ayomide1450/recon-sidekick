# Chrome Web Store submission pack

Everything needed to fill in the Developer Dashboard. Copy the fields below verbatim.

**Upload file:** `dist/recon-sidekick-0.1.0.zip` (build with `npm run package`)
**Screenshots:** `dist/store/*.png` — three at 1280×800, the required size
**Privacy policy URL:** `https://github.com/Ayomide1450/recon-sidekick/blob/main/PRIVACY.md`
**Homepage URL:** `https://github.com/Ayomide1450/recon-sidekick`
**Category:** Developer Tools
**Language:** English

---

## Listing copy

### Name
```
Recon Sidekick
```

### Short description (132 char limit)
```
Durable local memory of a target's client surface. Shows what changed since last time, and what you never reached.
```

### Detailed description

```
Recon Sidekick keeps a durable, local record of a web application's client-side surface
so you can see two things that normally take hours of manual re-exploration.

WHAT CHANGED SINCE LAST TIME
Come back to an app after a few weeks and the popup tells you what moved: endpoints that
did not exist on your last visit, new client routes, new feature-flag and role strings,
and which JavaScript bundles changed. New code is under-tested code, and this is how you
find it without starting over.

WHAT YOU NEVER REACHED
An application's own JavaScript names the routes and endpoints it knows about, including
ones no on-screen control will take you to. Recon Sidekick compares that declared surface
against what your browsing actually exercised, and shows you the difference.

HOW IT WORKS
It watches your ordinary browsing. There is no crawler, no fuzzer, and no scanning. The
only network request it ever makes is re-reading a JavaScript file the page already
downloaded, served from your browser cache.

SCOPE IS EXPLICIT
Nothing is recorded until you arm a specific program and grant permission for exactly
those hosts. Content scripts are registered dynamically for armed origins only. Every
other site you visit is untouched and unrecorded.

PRIVACY
Everything stays on your machine in local browser storage. No server, no account, no
analytics, no telemetry. The extension records URL shapes, not contents: it stores no
request or response bodies, no header values, no cookies, and no query parameter values
— parameter names only.

FEATURES
• Unreached — declared surface your browsing never touched, ranked by interest
• Timeline — per-visit history of what appeared and what changed
• Surface — full searchable inventory, exportable to JSON or line-per-value
• Notes — free-text working notes per target
• One-key dismiss for noise, so the list stays useful

OPEN SOURCE
Source, design notes, and tests: https://github.com/Ayomide1450/recon-sidekick

Only use this on applications you are authorised to test.
```

---

## Permission justifications

The dashboard requires a justification per permission. These are the ones to paste.

### `storage`
```
Stores the user's list of armed programs and their host patterns. Without it the
extension cannot remember which targets the user opted in to, and would have to re-ask on
every browser restart.
```

### `unlimitedStorage`
```
The extension's core feature is a durable record of a target's surface across months of
use. A heavily browsed application can exceed the default quota, and silently losing
history would defeat the extension's only purpose.
```

### `scripting`
```
Used to register content scripts dynamically for the specific hosts the user has armed,
via chrome.scripting.registerContentScripts. This is a deliberate privacy choice: rather
than declaring broad content script matches in the manifest that would run everywhere,
the extension registers them only for origins the user explicitly granted.
```

### `tabs`
```
Needed to read the URL of the active tab, so the popup can tell the user whether the site
they are on is armed, and to reload the tab after arming so recording can begin. Tab
URLs are used for this scope check only and tabs on unarmed hosts are never recorded.
```

### `webRequest`
```
Used in observe-only mode to learn which JavaScript files an armed page loaded, so those
bundles can be analysed for the routes and endpoints the application declares. No
blocking, redirecting, or modification of any request occurs; the extension never alters
network traffic.
```

### Host permissions (`*://*/*`, optional)
```
Declared as OPTIONAL, never granted by default. The extension cannot request a specific
pattern in advance because the hosts are chosen by the user at runtime — they are
whichever application the user is authorised to test. At the moment the user arms a
program, the extension calls chrome.permissions.request for exactly the host patterns
they entered, and Chrome shows them that prompt. Nothing is observed or recorded on any
host the user has not armed, and content scripts are registered only for granted origins.
```

### Single purpose statement
```
Recon Sidekick has one purpose: to record and present the client-side surface of web
applications the user has explicitly armed, so the user can see what changed since their
last visit and what surface they have not yet exercised.
```

### Data usage disclosures

Tick **"Website content"** and **"User activity"**, then certify all three:

- ☑ I do not sell or transfer user data to third parties, outside of approved use cases
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending

All collected data remains in local browser storage and is never transmitted.

---

## Before you submit

1. **Load it unpacked and use it on a real target first.** The runtime path has not been
   exercised end to end. Shipping untested code to a store with multi-day review cycles
   is the expensive way to find a bug.
2. Expect review friction on the broad optional host permission and on `webRequest`.
   Both are justified above, but reviews of security tooling tend to be slow and may come
   back with questions. Answer them with the justifications above.
3. Consider whether you want this publicly associated with your bug bounty handle before
   publishing under your real name.

## Steps you have to perform yourself

1. Register a Chrome Web Store developer account (one-time 5 USD fee) at
   https://chrome.google.com/webstore/devconsole
2. Create a new item and upload `dist/recon-sidekick-0.1.0.zip`
3. Paste the listing copy, justifications, and privacy policy URL above
4. Upload the three screenshots from `dist/store/`
5. Submit for review
