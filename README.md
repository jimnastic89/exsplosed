# Explosed

A Chrome extension that polls the Splose API to expose actionable items to
the user via a toolbar badge, reminder toasts, and a toggleable side panel.


- **The API host is fixed for every business**: `https://api.splose.com/v1`.
  It is *not* a per-business subdomain — the API key alone identifies your
  workspace. The `subdomain` field in settings is only used to build the
  clickable **web app** link to an invoice
  (`https://<subdomain>.splose.com/invoices/<id>/view`), which is a
  separate assumption carried over from the original brief, not something
  in the API spec — worth confirming against one real invoice link before
  fully trusting it (open an invoice in Splose and compare the URL shape).
- **Pagination is cursor-based** (`id_gt`/`id_lt`), not page numbers.
  Splose's own doc has the `links.previousPage`/`links.nextPage`
  descriptions swapped relative to their examples and doesn't state a
  default sort direction, so `paginate()` in `api.js` doesn't assume one —
  it detects ascending vs. descending from the first page's own id order
  and walks the correct way from there. (An earlier version assumed
  ascending-by-id always; on any endpoint that actually defaults to
  newest-first, that silently stopped after the first page and dropped
  everything older — this showed up as patients resolving to "Unknown
  patient" despite clearly existing in `/patients`.)

## Why there's a separate `names.js`

Invoices only carry `patientId`/`contactId`. There's no bulk "give me
names for these 5 ids" endpoint — `/patients` and `/contacts` only support
pagination or search-by-firstname/lastname/email. Looking up a name per
invoice on every poll would multiply the API call count fast. Instead,
`names.js` pulls the *entire* patient and contact lists once, caches them
by id in `chrome.storage.local`, and rebuilds that cache at most every 12
hours (or immediately if it's missing). The trade-off: a brand-new
patient's name might not show correctly until the next rebuild — reasonable
given names change far less often than invoice status, and it keeps the
15-minute poll cycle to a single, small, status-filtered `/invoices` call.

## The waitlist section

Added the same way as invoices, sharing the same poll cycle and API key:

- `/waitlists?isActive=true` is fetched each poll (same cursor-pagination
  approach as invoices — see `fetchActiveWaitlist` in `api.js`).
- Waitlist entries only carry `patientId` and `practitionerId`, no names —
  resolved through the same shared cache in `names.js` used for invoice
  contact names, now extended to also cache `/practitioners`. A poll that
  touches both invoices and the waitlist only rebuilds that cache once.
- The side panel's collapsed count is **distinct patients**, not raw
  waitlist entries — a patient waiting on more than one
  practitioner/service counts once for the headline number, but still
  appears in each relevant practitioner group when expanded. Worth
  flagging as a judgment call in case "total people" was meant more
  literally as entry count.
- Expanded view groups entries by practitioner name (alphabetical,
  "Unassigned" — no `practitionerId` set — sorted last).
- Each row links to `https://<subdomain>.splose.com/patients/<patientId>/details`
  using the same `subdomain` setting as the invoice links.
- No notifications or diffing for the waitlist — it's a live snapshot on
  every poll, not something that needs acknowledging like a paid invoice.
- The API doesn't expose an actual "date added to waitlist" field (despite
  accepting `dateAddedGt`/`dateAddedLt` as query filters) — `createdAt` is
  used as a stand-in for "waiting since" in the UI.

Both sections minimise/expand independently and remember their own
collapsed state (`invoicesCollapsed` / `waitlistCollapsed` in
`chrome.storage.local`).

## Loading it for development

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select this folder.
3. Click the extension icon → it'll prompt you to open **Settings**
   (or right-click the icon → Options).
4. Enter your Splose subdomain and API key, set the overdue threshold, save.
5. Visit any `https://<yourbusiness>.splose.com/...` page — the side panel
   should appear automatically alongside it.

Whenever you edit the code, go back to `chrome://extensions` and hit the
refresh icon on the extension's card to reload it.

## How the pieces fit together

- **`background.js`** — the service worker. Registers a `declarativeNetRequest`
  rule to set the `User-Agent` header (see note below), runs the
  `chrome.alarms` poll loop (invoices and waitlist, back-to-back each
  tick), does the diff between polls for invoices, drives the badge
  count and notifications, and toggles the side panel on/off per tab based
  on whether it's a `*.splose.com` URL.
- **`api.js`** — talks to the Splose API. Sequential cursor pagination, one
  call at a time, by design — that's the traffic pattern least likely to
  trip the 1-second-average-latency or 60/minute limits.
- **`names.js`** — resolves `patientId`/`contactId` into display names via
  a periodically-rebuilt local cache, so we're not hitting `/patients` or
  `/contacts` on every single poll.
- **`config.js`** — reads/writes settings and the API key. See the security
  note below for what "secure storage" actually means here.
- **`sidepanel.html/js`** — the persistent panel UI. Reads the same
  `trackedInvoices` state the background script writes, and re-renders
  live via `chrome.storage.onChanged` — so it stays in sync even if the
  panel was closed during the last poll. Has a minimise/expand toggle that
  persists across sessions.
- **`options.html/js`** — settings UI: subdomain, API key, age threshold,
  escalation threshold, poll interval, reminder cadence, and a `role`
  dropdown that's currently just reception vs. a "coming soon" clinician
  option (see below).

## Why `User-Agent` needed a workaround

`fetch()` cannot set a `User-Agent` header — Chrome (and every browser)
treats it as a ["forbidden request header"](https://fetch.spec.whatwg.org/#forbidden-request-header)
and silently drops any attempt to set it via JS. The only way to satisfy
Splose's requirement from an extension is to rewrite the header at the
network layer, which is what the `declarativeNetRequest` rule in
`background.js` does for any request to `api.splose.com/v1/*` (the fixed
API host — see the schema section above).

## About API key storage

The key lives in `chrome.storage.local`, which is isolated per-extension —
not readable by Splose's own pages, other extensions, or anything on the
open web, and it never leaves the machine (it's not `chrome.storage.sync`).
That's the realistic ceiling for a plain browser extension; there's no
access to the OS keychain from here. If you later want central issuance or
revocation across many clinician machines, that's the point where a small
backing service (issuing short-lived tokens per install) would replace pure
client-side storage — not something to bolt on later inside the extension
itself.

If you'd rather the key not persist to disk at all (re-enter it each time
Chrome restarts), flip `PERSIST_API_KEY = false` at the top of `config.js`
to switch it to `chrome.storage.session`.

## Respecting Splose's API limits

- **Latency**: requests are sequential, not parallel, and the poll interval
  defaults to 15 minutes (floor of 5 minutes enforced in code) — this
  keeps total call volume far below anything that would risk the
  1-second average-latency cutoff.
- **60 calls/minute**: a single poll cycle only makes enough calls to
  paginate through unpaid invoices once; `maxPages` in `api.js` is a safety
  valve (20 pages) against a pagination bug looping forever and burning
  through the limit.
- **User-Agent**: handled via the `declarativeNetRequest` rule described
  above — every call to `/v1/*` carries it automatically.
- **Name cache rebuilds** (`names.js`) paginate through all of `/patients`
  and `/contacts`, but only once every 12 hours, not every 15-minute poll —
  for a typical single-clinic patient list this is a handful of calls,
  once, twice a day.

If invoice volume ever grows enough that pagination alone approaches the
per-minute limit, the fix is a small delay between page requests in
`fetchAllUnpaidInvoices()` (currently sequential `await`s already give some
natural spacing, but an explicit `setTimeout` gap is the next lever).

## Publishing path (once stable)

1. Keep iterating as unpacked/developer mode while you dogfood it on the
   reception machine.
2. Zip the folder contents (not the folder itself — the manifest needs to
   be at the zip root).
3. Chrome Web Store Developer Dashboard → pay the one-time $5 registration
   fee if you haven't already → **New item** → upload the zip.
4. Set visibility to **Unlisted**. You'll get a direct install link;
   anyone without that link won't find it via search.
5. Every future update is just: bump `"version"` in `manifest.json`, zip,
   upload a new package to the same listing. Installed copies auto-update
   through Chrome's normal extension update pipeline — no manual
   redistribution.
6. Source of truth stays in a private GitHub repo; the Web Store package is
   just a built artifact of it.

## Designed to grow

- **Role/scope**: `config.js` already has `role` (`reception`/`clinician`)
  and a `scopeContactIds` field wired into storage. Right now
  `pollInvoices()` in `background.js` has a marked pass-through comment
  where per-clinician filtering would slot in — restricting `flagged` to
  invoices whose `contactId` is in `scopeContactIds` — without touching
  the polling, diffing, badge, or notification plumbing at all.
- **Other alert types**: the generic pipeline is poll → normalize →
  age/rule filter → diff against tracked state → badge/notify/panel. Adding
  , say, upcoming-appointment or unfilled-form alerts means writing a new
  `fetchX()` + `normalizeX()` pair and a second `trackedX` storage bucket,
  reusing the same alarm, badge-aggregation, notification, and side-panel
  rendering patterns already in place.
