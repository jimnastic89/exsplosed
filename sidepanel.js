import { getConfig } from "./config.js";

const unconfiguredState = document.getElementById("unconfiguredState");
const mainContent = document.getElementById("mainContent");
const openOptionsBtn = document.getElementById("openOptionsBtn");
openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

function daysAgo(isoDate) {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
}

function formatAmount(invoice) {
  if (invoice.amountDue == null) return "";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency || "AUD" }).format(
    invoice.amountDue
  );
}

async function openUrlInCurrentTab(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.update(tab.id, { url });
  } else {
    chrome.tabs.create({ url });
  }
}

// ---------------------------------------------------------------------------
// Availability row: 7 day-of-week cells + 3 time-of-day cells, matching the
// day/time indicator style on Splose's own waitlist page.
// ---------------------------------------------------------------------------

const DAY_DEFS = [
  { name: "Sunday", label: "S" },
  { name: "Monday", label: "M" },
  { name: "Tuesday", label: "T" },
  { name: "Wednesday", label: "W" },
  { name: "Thursday", label: "T" },
  { name: "Friday", label: "F" },
  { name: "Saturday", label: "S" },
];

// Small inline icons (not emoji) so they inherit color via `currentColor`
// and can switch between "active" and "inactive" styling the same way the
// day-letter circles do.
const TIME_DEFS = [
  {
    key: "morning",
    label: "Morning",
    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v3M4.2 10.2l1.4 1.4M19.8 10.2l-1.4 1.4M3 18h18M6 18a6 6 0 0 1 12 0"/></svg>`,
  },
  {
    key: "afternoon",
    label: "Afternoon",
    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  },
  {
    key: "evening",
    label: "Evening",
    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>`,
  },
];

function dayCellsHtml(preferredDays) {
  const days = preferredDays || [];
  return DAY_DEFS.map(
    (d) =>
      `<span class="day-cell${days.includes(d.name) ? " active" : ""}" title="${d.name}">${d.label}</span>`
  ).join("");
}

function timeCellsHtml(preferredTime) {
  const times = preferredTime || [];
  return TIME_DEFS.map(
    (t) =>
      `<span class="time-cell${times.includes(t.key) ? " active" : ""}" title="${t.label}">${t.icon}</span>`
  ).join("");
}

function availabilityRowHtml(item) {
  return `
    <div class="availability-row">
      <div class="availability-group availability-days">${dayCellsHtml(item.preferredDays)}</div>
      <div class="availability-group availability-times">${timeCellsHtml(item.preferredTime)}</div>
    </div>
  `;
}

/**
 * Wires up a section's minimise/expand toggle. Each section persists its
 * own collapsed state under its own storage key, so collapsing invoices
 * doesn't affect the waitlist section and vice versa.
 */
function setupCollapsibleSection({ toggleBtn, toggleIcon, collapsedBar, content, storageKey }) {
  function apply(collapsed) {
    content.hidden = collapsed;
    collapsedBar.hidden = !collapsed;
    toggleIcon.textContent = collapsed ? "▸" : "▾";
    toggleBtn.title = collapsed ? "Expand" : "Minimise";
  }

  toggleBtn.addEventListener("click", async () => {
    const { [storageKey]: collapsed } = await chrome.storage.local.get(storageKey);
    const next = !collapsed;
    await chrome.storage.local.set({ [storageKey]: next });
    apply(next);
  });

  (async () => {
    const { [storageKey]: collapsed } = await chrome.storage.local.get(storageKey);
    apply(!!collapsed);
  })();
}

// ---------------------------------------------------------------------------
// Invoices section
// ---------------------------------------------------------------------------

const invoicesToggle = {
  toggleBtn: document.getElementById("invoicesToggleBtn"),
  toggleIcon: document.getElementById("invoicesToggleIcon"),
  collapsedBar: document.getElementById("invoicesCollapsedBar"),
  content: document.getElementById("invoicesContent"),
  storageKey: "invoicesCollapsed",
};
setupCollapsibleSection(invoicesToggle);

const invoicesDot = document.getElementById("invoicesDot");
const invoicesCountPill = document.getElementById("invoicesCountPill");
const invoicesCollapsedText = document.getElementById("invoicesCollapsedText");
const invoicesEmpty = document.getElementById("invoicesEmpty");
const invoiceList = document.getElementById("invoiceList");
const invoicesLastChecked = document.getElementById("invoicesLastChecked");

function renderInvoices(trackedInvoices, lastPolledAt) {
  const invoices = Object.values(trackedInvoices).sort((a, b) => daysAgo(b.dueDate) - daysAgo(a.dueDate));

  invoicesCountPill.textContent = String(invoices.length);
  invoicesCountPill.classList.toggle("zero", invoices.length === 0);
  invoicesDot.className = "dot " + (invoices.length ? "flagged" : "ok");
  invoicesCollapsedText.textContent = `${invoices.length} unpaid invoice${invoices.length === 1 ? "" : "s"}`;

  invoicesEmpty.hidden = invoices.length !== 0;
  invoiceList.innerHTML = "";

  for (const inv of invoices) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "invoice-row";
    btn.innerHTML = `
      <div class="invoice-row-top">
        <span class="invoice-contact"></span>
        <span class="invoice-amount"></span>
      </div>
      <div class="invoice-row-bottom">
        <span class="invoice-number"></span>
        <span class="age-badge"></span>
      </div>
    `;
    btn.querySelector(".invoice-contact").textContent = inv.contactName || "Unknown client";
    btn.querySelector(".invoice-amount").textContent = formatAmount(inv);
    btn.querySelector(".invoice-number").textContent = inv.number ? `Invoice ${inv.number}` : "";
    const days = daysAgo(inv.dueDate) ?? 0;
    btn.querySelector(".age-badge").textContent = `${days}d overdue`;
    btn.addEventListener("click", () => openUrlInCurrentTab(inv.url));
    li.appendChild(btn);
    invoiceList.appendChild(li);
  }

  invoicesLastChecked.textContent = lastPolledAt
    ? `Last checked ${new Date(lastPolledAt).toLocaleTimeString()}`
    : "Waiting for first check…";
}

// ---------------------------------------------------------------------------
// Waitlist section
// ---------------------------------------------------------------------------

const waitlistToggle = {
  toggleBtn: document.getElementById("waitlistToggleBtn"),
  toggleIcon: document.getElementById("waitlistToggleIcon"),
  collapsedBar: document.getElementById("waitlistCollapsedBar"),
  content: document.getElementById("waitlistContent"),
  storageKey: "waitlistCollapsed",
};
setupCollapsibleSection(waitlistToggle);

const waitlistDot = document.getElementById("waitlistDot");
const waitlistCountPill = document.getElementById("waitlistCountPill");
const waitlistCollapsedText = document.getElementById("waitlistCollapsedText");
const waitlistEmpty = document.getElementById("waitlistEmpty");
const waitlistGroups = document.getElementById("waitlistGroups");
const waitlistLastChecked = document.getElementById("waitlistLastChecked");

// Which practitioner groups are currently expanded. Lives only in memory
// for this side panel session — groups start minimised by default every
// time the panel is opened fresh, and stay however the user left them for
// as long as the panel stays open (re-polling rebuilds the list but
// doesn't reset a group the user already opened).
const expandedGroups = new Set();

function renderWaitlist(items, lastPolledAt) {
  // "People on the waitlist" = distinct patients, not raw entry count — a
  // patient waiting on more than one practitioner/service still counts once
  // for the headline number, though they'll appear in each relevant group
  // below.
  const distinctPatientCount = new Set(items.map((i) => i.patientId)).size;

  waitlistCountPill.textContent = String(distinctPatientCount);
  waitlistCountPill.classList.toggle("zero", distinctPatientCount === 0);
  waitlistDot.className = "dot " + (distinctPatientCount ? "flagged" : "ok");
  waitlistCollapsedText.textContent = `${distinctPatientCount} ${
    distinctPatientCount === 1 ? "person" : "people"
  } waiting`;

  waitlistEmpty.hidden = items.length !== 0;
  waitlistGroups.innerHTML = "";

  // Group by practitioner display name (already resolved by names.js),
  // "Unassigned" sorted to the end.
  const groups = new Map();
  for (const item of items) {
    const key = item.practitionerName || "Unassigned";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const sortedGroupNames = [...groups.keys()].sort((a, b) => {
    if (a === "Unassigned") return 1;
    if (b === "Unassigned") return -1;
    return a.localeCompare(b);
  });

  for (const groupName of sortedGroupNames) {
    const groupItems = groups.get(groupName).sort((a, b) => (a.waitingSince || "").localeCompare(b.waitingSince || ""));
    const isExpanded = expandedGroups.has(groupName);

    const wrapper = document.createElement("div");
    wrapper.className = "waitlist-group";

    const header = document.createElement("button");
    header.className = "waitlist-group-header";
    header.innerHTML = `
      <span class="waitlist-group-title">${groupName} (${groupItems.length})</span>
      <span class="waitlist-group-chevron">${isExpanded ? "▾" : "▸"}</span>
    `;

    const ul = document.createElement("ul");
    ul.className = "waitlist-group-list";
    ul.hidden = !isExpanded;

    header.addEventListener("click", () => {
      if (expandedGroups.has(groupName)) {
        expandedGroups.delete(groupName);
      } else {
        expandedGroups.add(groupName);
      }
      const nowExpanded = expandedGroups.has(groupName);
      ul.hidden = !nowExpanded;
      header.querySelector(".waitlist-group-chevron").textContent = nowExpanded ? "▾" : "▸";
    });

    for (const item of groupItems) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "waitlist-row";
      btn.title = item.patientId ? `Patient ID: ${item.patientId}` : "Patient ID: unknown";
      btn.innerHTML = `
        <div class="waitlist-row-top">
          <span class="waitlist-patient"></span>
          <span class="waitlist-waiting-since"></span>
        </div>
        ${availabilityRowHtml(item)}
      `;
      btn.querySelector(".waitlist-patient").textContent = item.patientName || "Unknown patient";
      const days = daysAgo(item.waitingSince);
      btn.querySelector(".waitlist-waiting-since").textContent =
        days == null ? "" : `waiting ${days}d`;
      btn.addEventListener("click", () => openUrlInCurrentTab(item.url));
      li.appendChild(btn);
      ul.appendChild(li);
    }

    wrapper.appendChild(header);
    wrapper.appendChild(ul);
    waitlistGroups.appendChild(wrapper);
  }

  waitlistLastChecked.textContent = lastPolledAt
    ? `Last checked ${new Date(lastPolledAt).toLocaleTimeString()}`
    : "Waiting for first check…";
}

// ---------------------------------------------------------------------------
// Shared render + live updates
// ---------------------------------------------------------------------------

async function render() {
  const config = await getConfig();
  if (!config.apiKey || !config.subdomain) {
    unconfiguredState.hidden = false;
    mainContent.hidden = true;
    return;
  }
  unconfiguredState.hidden = true;
  mainContent.hidden = false;

  const { trackedInvoices = {}, lastPolledAt, waitlistItems = [], waitlistPolledAt } =
    await chrome.storage.local.get(["trackedInvoices", "lastPolledAt", "waitlistItems", "waitlistPolledAt"]);

  renderInvoices(trackedInvoices, lastPolledAt);
  renderWaitlist(waitlistItems, waitlistPolledAt);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === "local" &&
    (changes.trackedInvoices ||
      changes.lastPolledAt ||
      changes.waitlistItems ||
      changes.waitlistPolledAt ||
      changes.apiKey ||
      changes.subdomain)
  ) {
    render();
  }
});

render();
