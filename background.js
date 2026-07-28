import { getConfig, invoiceUrl, patientDetailsUrl } from "./config.js";
import { fetchAllUnpaidInvoices, fetchActiveWaitlist, RateLimitError } from "./api.js";
import { attachContactNames, attachWaitlistNames } from "./names.js";

const ALARM_NAME = "splose-poll";
const USER_AGENT_RULE_ID = 1;
const USER_AGENT_VALUE = "SploseInvoiceWatcher/0.1 (internal reception tool)";

// ---------------------------------------------------------------------------
// Setup: User-Agent header rewrite (fetch() can't set this header itself —
// see api.js for why) and the recurring poll alarm.
// The API host is fixed (https://api.splose.com/v1) per the OpenAPI spec —
// it's the same host for every business, not a subdomain — so the rule
// targets that host specifically rather than a wildcard.
// ---------------------------------------------------------------------------

async function ensureUserAgentRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [USER_AGENT_RULE_ID],
    addRules: [
      {
        id: USER_AGENT_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "User-Agent", operation: "set", value: USER_AGENT_VALUE },
          ],
        },
        condition: {
          urlFilter: "||api.splose.com/v1/",
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ],
  });
}

async function ensureAlarm() {
  const { pollIntervalMinutes } = await getConfig();
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== pollIntervalMinutes) {
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: Math.max(pollIntervalMinutes, 5), // 5 min floor, be a good API citizen
      delayInMinutes: 0.1,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureUserAgentRule();
  ensureAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  ensureUserAgentRule();
  ensureAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollAll();
});

// Re-arm the alarm if settings change (e.g. user edits poll interval in options).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.pollIntervalMinutes) ensureAlarm();
});

// ---------------------------------------------------------------------------
// Side panel: auto-show only on Splose tabs, closed elsewhere.
// ---------------------------------------------------------------------------

function isSploseUrl(url) {
  try {
    return new URL(url).hostname.endsWith(".splose.com");
  } catch {
    return false;
  }
}

async function syncSidePanelForTab(tabId, url) {
  if (isSploseUrl(url)) {
    await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
  } else {
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) syncSidePanelForTab(tabId, changeInfo.url);
  else if (changeInfo.status === "complete" && tab.url) syncSidePanelForTab(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url) syncSidePanelForTab(tabId, tab.url);
});

// ---------------------------------------------------------------------------
// Poll cycle: fetch -> filter by age -> diff against tracked state -> notify.
// ---------------------------------------------------------------------------

function daysBetween(isoDate) {
  if (!isoDate) return 0;
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

function ageInDays(invoice) {
  // Prefer "days since due"; fall back to "days since issued" if no due date.
  if (invoice.dueDate) return daysBetween(invoice.dueDate);
  if (invoice.issuedDate) return daysBetween(invoice.issuedDate);
  return 0;
}

let pollInFlight = false;

/**
 * Runs both poll cycles back-to-back on the same alarm tick. Sequential,
 * not parallel — same reasoning as the sequential pagination in api.js:
 * gentler, more predictable traffic against Splose's rate limit. Each
 * cycle is wrapped so a failure in one (e.g. a transient invoices error)
 * doesn't prevent the other from running.
 */
export async function pollAll() {
  if (pollInFlight) return; // don't overlap polls if one is slow
  pollInFlight = true;
  try {
    const config = await getConfig();
    if (!config.apiKey || !config.subdomain) {
      await chrome.action.setBadgeText({ text: "" });
      return; // not configured yet — options page will prompt the user
    }
    await pollInvoices(config);
    await pollWaitlist(config);
  } finally {
    pollInFlight = false;
  }
}

async function pollInvoices(config) {
  let invoices;
  try {
    invoices = await fetchAllUnpaidInvoices(config);
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn("Splose rate limit hit fetching invoices — backing off this cycle.");
      return;
    }
    console.error("Splose invoice poll failed:", err);
    return;
  }

  let flagged = invoices.filter((inv) => ageInDays(inv) >= config.ageThresholdDays);
  // Future scoping hook: if config.role === "clinician", filter further by
  // config.scopeContactIds here before diffing. Left as a pass-through for now.

  flagged = await attachContactNames(flagged, config);

  await diffAndUpdateInvoices(flagged, config);
}

async function pollWaitlist(config) {
  let items;
  try {
    items = await fetchActiveWaitlist(config);
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn("Splose rate limit hit fetching waitlist — backing off this cycle.");
      return;
    }
    console.error("Splose waitlist poll failed:", err);
    return;
  }

  // Future scoping hook: same clinician-scoping filter point as invoices.
  items = await attachWaitlistNames(items, config);
  items = items.map((item) => ({ ...item, url: patientDetailsUrl(config.subdomain, item.patientId) }));

  await chrome.storage.local.set({ waitlistItems: items, waitlistPolledAt: Date.now() });
}

async function diffAndUpdateInvoices(flagged, config) {
  const { trackedInvoices = {} } = await chrome.storage.local.get("trackedInvoices");
  const next = { ...trackedInvoices };
  const now = Date.now();
  const flaggedIds = new Set(flagged.map((inv) => inv.id));

  // Newly flagged or still-outstanding invoices.
  for (const inv of flagged) {
    const existing = next[inv.id];
    const url = invoiceUrl(config.subdomain, inv.id);

    if (!existing) {
      next[inv.id] = {
        ...inv,
        url,
        firstFlaggedAt: now,
        lastNotifiedAt: now,
        notifyCount: 1,
      };
      fireNotification(next[inv.id], config, { isFirst: true });
      continue;
    }

    // Refresh live fields (amount could change, due date could shift, etc.)
    next[inv.id] = { ...existing, ...inv, url };

    const hoursSinceNotified = (now - existing.lastNotifiedAt) / (1000 * 60 * 60);
    if (hoursSinceNotified >= config.notifyCadenceHours) {
      next[inv.id].lastNotifiedAt = now;
      next[inv.id].notifyCount = (existing.notifyCount || 0) + 1;
      fireNotification(next[inv.id], config, { isFirst: false });
    }
  }

  // Anything tracked but no longer flagged has been resolved (paid, or aged
  // back under the threshold, which in practice means paid).
  for (const [id, existing] of Object.entries(trackedInvoices)) {
    if (!flaggedIds.has(id)) {
      fireResolvedNotification(existing);
      delete next[id];
    }
  }

  await chrome.storage.local.set({ trackedInvoices: next, lastPolledAt: now });
  await chrome.action.setBadgeText({ text: flagged.length ? String(flagged.length) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#B4322E" });
}

function fireNotification(invoice, config, { isFirst }) {
  const ageDays = Math.floor(ageInDays(invoice));
  const escalated = ageDays >= config.escalateAfterDays;
  const amount = invoice.amountDue != null ? `${invoice.currency ?? ""} ${invoice.amountDue}`.trim() : "";

  chrome.notifications.create(invoice.id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    priority: escalated ? 2 : 1,
    title: isFirst
      ? `Overdue invoice: ${invoice.contactName}`
      : escalated
      ? `Still unpaid (${ageDays}d): ${invoice.contactName}`
      : `Reminder: ${invoice.contactName} still unpaid`,
    message: [
      invoice.number ? `Invoice ${invoice.number}` : null,
      amount || null,
      `${ageDays} day${ageDays === 1 ? "" : "s"} overdue`,
    ]
      .filter(Boolean)
      .join(" · "),
  });
}

function fireResolvedNotification(invoice) {
  chrome.notifications.create(`resolved-${invoice.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    priority: 0,
    title: `Paid: ${invoice.contactName}`,
    message: invoice.number ? `Invoice ${invoice.number} is now marked paid.` : "Invoice is now marked paid.",
  });
}

// Clicking a reminder notification opens the invoice; clicking a "resolved"
// toast just dismisses it.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId.startsWith("resolved-")) {
    chrome.notifications.clear(notificationId);
    return;
  }
  const { trackedInvoices = {} } = await chrome.storage.local.get("trackedInvoices");
  const invoice = trackedInvoices[notificationId];
  if (invoice?.url) chrome.tabs.create({ url: invoice.url });
  chrome.notifications.clear(notificationId);
});

// Let the options page or side panel ask for an immediate poll (e.g. right
// after the user saves their API key for the first time).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "POLL_NOW") {
    pollAll().then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }
});
