// names.js
// Invoices only carry patientId and a nullable contactId, and waitlist
// entries only carry patientId and practitionerId — none of them include a
// display name. The API has no "fetch these specific ids" filter for
// /patients, /contacts, or /practitioners, only pagination and
// search-by-firstname/lastname/email. So rather than issue a lookup per
// invoice or waitlist entry (which would multiply our call count with
// every poll), we periodically pull the *entire* patient, contact, and
// practitioner lists once, cache them by id, and reuse that cache across
// polls for both the invoice and waitlist sections.
//
// This trades a small amount of staleness (a brand-new patient's name
// might not resolve until the next cache rebuild) for a big reduction in
// API calls — appropriate given Splose's 60/minute limit and the fact
// that names change far less often than invoice status or waitlist
// membership does.

import { fetchAllPages } from "./api.js";

const REBUILD_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Bump this whenever the cache's shape changes (e.g. adding
// practitionerNames for the waitlist feature, or practitionerActive for
// filtering out inactive practitioners) OR whenever the underlying fetch
// logic changes in a way that makes an existing cache's *contents*
// suspect (e.g. the pagination-direction fix — a cache built by the
// buggy version may be silently missing most patients, and would
// otherwise sit around for up to 12h before naturally refreshing).
const CACHE_VERSION = 5;

function displayNameFromPatient(p) {
  return [p.preferredName || p.firstname, p.lastname].filter(Boolean).join(" ") || "Unknown patient";
}

function displayNameFromContact(c) {
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "Unknown contact";
}

function displayNameFromPractitioner(p) {
  return [p.firstname, p.lastname].filter(Boolean).join(" ") || "Unknown practitioner";
}

function normalizeCache(raw) {
  // However we got here — a fresh rebuild, a stored cache from disk, or a
  // fallback after a failed rebuild — always hand back the same guaranteed
  // shape. This is the one place that matters: every consumer below can
  // then safely assume patientNames/contactNames/practitionerNames exist,
  // no defensive checks needed anywhere else.
  return {
    patientNames: raw?.patientNames ?? {},
    contactNames: raw?.contactNames ?? {},
    practitionerNames: raw?.practitionerNames ?? {},
    practitionerActive: raw?.practitionerActive ?? {},
    builtAt: raw?.builtAt ?? 0,
    version: CACHE_VERSION,
  };
}

async function rebuildCache({ apiKey }) {
  const [patients, contacts, practitioners] = await Promise.all([
    fetchAllPages("/patients", { apiKey }),
    fetchAllPages("/contacts", { apiKey }),
    fetchAllPages("/practitioners", { apiKey }),
  ]);

  const patientNames = {};
  for (const p of patients) patientNames[String(p.id)] = displayNameFromPatient(p);

  const contactNames = {};
  for (const c of contacts) contactNames[String(c.id)] = displayNameFromContact(c);

  const practitionerNames = {};
  const practitionerActive = {};
  for (const p of practitioners) {
    practitionerNames[String(p.id)] = displayNameFromPractitioner(p);
    // isActive is a plain boolean on /practitioners. Treat anything other
    // than an explicit `false` as active, so a practitioner record missing
    // the field entirely (shouldn't happen per the spec, but just in
    // case) doesn't get silently hidden.
    practitionerActive[String(p.id)] = p.isActive !== false;
  }

  const cache = normalizeCache({
    patientNames,
    contactNames,
    practitionerNames,
    practitionerActive,
    builtAt: Date.now(),
  });
  await chrome.storage.local.set({ nameCache: cache });
  return cache;
}

async function getCache({ apiKey }, { forceRebuild = false } = {}) {
  const { nameCache } = await chrome.storage.local.get("nameCache");
  const stale =
    !nameCache ||
    nameCache.version !== CACHE_VERSION ||
    Date.now() - nameCache.builtAt > REBUILD_INTERVAL_MS;

  if (forceRebuild || stale) {
    try {
      return await rebuildCache({ apiKey });
    } catch (err) {
      console.error("Name cache rebuild failed, falling back to stale/empty cache:", err);
      // normalizeCache guarantees this is safe to use even if `nameCache`
      // is undefined, from an old version, or otherwise partial.
      return normalizeCache(nameCache);
    }
  }
  return normalizeCache(nameCache);
}

/**
 * Resolves a display name for an invoice: prefer the billed contact (if
 * one is set), otherwise fall back to the patient themselves.
 */
export async function resolveInvoiceContactName(invoice, config) {
  const cache = await getCache(config);
  if (invoice.contactId && cache.contactNames[invoice.contactId]) {
    return cache.contactNames[invoice.contactId];
  }
  if (invoice.patientId && cache.patientNames[invoice.patientId]) {
    return cache.patientNames[invoice.patientId];
  }
  return "Unknown client";
}

/**
 * Enriches a whole batch of invoices at once, rebuilding the cache at
 * most once per call (not once per invoice).
 */
export async function attachContactNames(invoices, config) {
  const cache = await getCache(config);
  return invoices.map((inv) => {
    const contactName =
      (inv.contactId && cache.contactNames[inv.contactId]) ||
      (inv.patientId && cache.patientNames[inv.patientId]) ||
      "Unknown client";
    return { ...inv, contactName };
  });
}

/**
 * Enriches a batch of waitlist entries with patient and practitioner
 * display names, using the same shared cache (so a poll that touches both
 * invoices and the waitlist only rebuilds the cache once). Also drops
 * entries assigned to a practitioner whose /practitioners record has
 * isActive === false — an entry with no practitioner assigned at all
 * ("Unassigned") is left alone, since there's no practitioner to be
 * inactive.
 */
export async function attachWaitlistNames(items, config) {
  const cache = await getCache(config);
  return items
    .filter((item) => !item.practitionerId || cache.practitionerActive[item.practitionerId] !== false)
    .map((item) => ({
      ...item,
      patientName: (item.patientId && cache.patientNames[item.patientId]) || "Unknown patient",
      practitionerName:
        (item.practitionerId && cache.practitionerNames[item.practitionerId]) || "Unassigned",
    }));
}
