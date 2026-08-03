# Exsplosed

A Chrome extension that watches your [Splose](https://splose.com) practice for overdue invoices and waitlist patients, so reception doesn't have to keep checking manually.

## What it does

- **Overdue invoices** — polls your Splose workspace on a schedule, flags invoices that are unpaid past a configurable age threshold, and shows desktop notifications when a new one is flagged or an existing one has gone unpaid long enough to remind again. A toolbar badge shows the current count.
- **Waitlist** — shows everyone currently on the active waitlist, grouped by practitioner, with each patient's name, how long they've been waiting, and their preferred days/times.
- **Side panel** — opens automatically on Splose pages and shows both lists live, with clickable rows that jump straight to the matching invoice or patient in Splose.
- **Options page** — set your Splose subdomain and API key, how many days overdue counts as "flagged," how often to check, how often to re-remind, and a couple of advanced performance limits (see below).

## Setup

1. Load the extension unpacked in Chrome (`chrome://extensions` → Developer mode → Load unpacked).
2. Open the extension's options page and enter:
   - Your Splose API key (from your Splose dashboard).
   - Your Splose subdomain (the `yourbusiness` in `yourbusiness.splose.com`) — used to build clickable links back into Splose.
3. Adjust the overdue threshold, check frequency, and reminder cadence to taste, then save.
4. Visit any page on your Splose subdomain — the side panel will open automatically.

## Settings reference

| Setting | What it controls |
|---|---|
| Splose subdomain / API key | Which workspace to connect to |
| Flag invoices this many days past due | Age threshold for "overdue" |
| Escalate tone/urgency after this many days | When reminders switch to a more urgent tone |
| Check for updates every | How often the extension polls Splose |
| Remind again after | Minimum gap between repeat reminders for the same invoice |
| This install is for | Reception (sees everything) or clinician (scoped view — coming soon) |
| Max individual notifications per check | Caps how many separate toast notifications can fire in one check before the rest are folded into a single summary notification |
| Max direct patient lookups per check | Caps how many one-off API lookups are made for waitlist patients not yet in the local name cache, before a full cache refresh is triggered instead |

## Requirements

- A Splose account with API access enabled, and an API key from your Splose dashboard.
- Chrome 114+ (for the Side Panel API).
