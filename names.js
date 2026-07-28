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

import { fetchAllPages, fetchPatientById } from "./api.js";

const REBUILD_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Bump this whenever the cache's shape changes, or whenever the
// underlying fetch logic changes in a way that makes an existing cache's
// *contents* suspect and worth rebuilding right away rather than waiting
// out the normal 12h TTL. Latest reason: rebuildCache used to fetch
// patients/contacts/practitioners concurrently via Promise.all, which (a)
// roughly tripled the instantaneous request rate against Splose's
// 60/minute limit, and (b) meant a single rate-limit error on any one of
// the three discarded the entire rebuild, including endpoints that had
// already succeeded — so a cache built under load could get stuck
// perpetually incomplete, retrying the same failing concurrent burst
// every poll. Now sequential, with independent per-endpoint fallback.
const CACHE_VERSION = 6;

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
    __rawPatients: raw?.__rawPatients ?? [],
    __rawContacts: raw?.__rawContacts ?? [],
    __rawPractitioners: raw?.__rawPractitioners ?? [],
  };
}

async function rebuildCache({ apiKey }, previousCache) {
  // Sequential, not concurrent — same reasoning as everywhere else this
  // codebase talks to Splose: running three paginated fetches at once
  // roughly triples the instantaneous request rate against the 60/minute
  // limit. Worse, the previous version used Promise.all, which means a
  // single 429 partway through *any* of the three discarded the whole
  // rebuild — including patients that may have already finished — and
  // since the cache stays "stale" afterwards, the next poll would retry
  // the same concurrent burst and could fail the same way indefinitely.
  // Fetching one at a time, and falling back independently per endpoint,
  // fixes both problems.
  const patients = await fetchListSafely("/patients", { apiKey }, previousCache?.__rawPatients);
  const contacts = await fetchListSafely("/contacts", { apiKey }, previousCache?.__rawContacts);
  const practitioners = await fetchListSafely("/practitioners", { apiKey }, previousCache?.__rawPractitioners);

  if (patients.length > 0) {
    // Sanity check: confirms the real shape of a patient record matches
    // what displayNameFromPatient()/the id lookup below assume. If this
    // looks different from { id, firstname, lastname, preferredName, ... }
    // that's the actual bug, not the caching/pagination machinery around it.
    console.info("[names.js] Sample raw patient record:", JSON.stringify(patients[0]));
  } else {
    console.warn("[names.js] /patients returned zero records.");
  }

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
    // Keep the raw lists around (not just the derived name maps) so a
    // future rebuild that fails on one endpoint can still fall back to
    // this endpoint's last-known-good raw data instead of an empty list.
    __rawPatients: patients,
    __rawContacts: contacts,
    __rawPractitioners: practitioners,
  });
  await chrome.storage.local.set({ nameCache: cache });
  console.info(
    `[names.js] Cache rebuilt: ${patients.length} patients, ${contacts.length} contacts, ` +
      `${practitioners.length} practitioners.`
  );
  return cache;
}

/**
 * Fetches one list endpoint, falling back to whatever we fetched
 * successfully last time (if any) rather than an empty list on failure —
 * so a transient rate limit on, say, /practitioners doesn't wipe out
 * practitioner names entirely, it just means they're one cycle stale.
 */
async function fetchListSafely(path, { apiKey }, previousRaw) {
  try {
    return await fetchAllPages(path, { apiKey });
  } catch (err) {
    console.error(`Fetching ${path} for the name cache failed, reusing last-known data:`, err);
    return previousRaw || [];
  }
}

async function getCache({ apiKey }, { forceRebuild = false } = {}) {
  const { nameCache } = await chrome.storage.local.get("nameCache");
  const stale =
    !nameCache ||
    nameCache.version !== CACHE_VERSION ||
    Date.now() - nameCache.builtAt > REBUILD_INTERVAL_MS;

  if (forceRebuild || stale) {
    console.info(
      `[names.js] Cache is ${!nameCache ? "missing" : nameCache.version !== CACHE_VERSION ? "an old version" : "stale (past 12h)"} — rebuilding.`
    );
    try {
      return await rebuildCache({ apiKey }, nameCache);
    } catch (err) {
      console.error("[names.js] Cache rebuild threw and was fully aborted, falling back:", err);
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

  const filtered = items.filter(
    (item) => !item.practitionerId || cache.practitionerActive[item.practitionerId] !== false
  );

  

  const enriched = [];
  for (const item of filtered) {
    let patientName = "Unknown patient";

    if (item.patientId) {
      if (cache.patientNames[item.patientId]) {
        patientName = cache.patientNames[item.patientId];
      } else {
        const directPatient = await fetchPatientById(config, item.patientId);
        if (directPatient) {
          patientName = displayNameFromPatient(directPatient);
          cache.patientNames[item.patientId] = patientName;
        }
      }
    }

    enriched.push({
      ...item,
      patientName,
      practitionerName: (item.practitionerId && cache.practitionerNames[item.practitionerId]) || "Unassigned",
    });
  }

  return enriched;

  /*const enriched = filtered.map((item) => {
    let resolvedName = "Unknown patient";
    if (item.patientId) {
      if (cache.patientNames[item.patientId]) {
        resolvedName = cache.patientNames[item.patientId];
      } else {
        resolvedName = `Patient #${item.patientId} (Not in cache)`;
      }
    }
    return {
      ...item,
      patientName: resolvedName,
      practitionerName: (item.practitionerId && cache.practitionerNames[item.practitionerId]) || "Unassigned",
    }
  }
  );*/

  // Diagnostic logging: if names still aren't resolving, this tells us
  // exactly what's mismatched instead of guessing again — check the
  // service worker console (chrome://extensions → this extension →
  // "service worker" under Inspect views → Console tab) after a poll.
  const unresolved = enriched.filter((item) => item.patientName === "Unknown patient" && item.patientId);
  if (unresolved.length > 0) {
    const cacheKeys = Object.keys(cache.patientNames);
    console.warn(
      `[names.js] ${unresolved.length}/${enriched.length} waitlist entries have a patientId ` +
        `not found in the name cache. Cache currently holds ${cacheKeys.length} patient names.`
    );
    console.warn(
      "[names.js] Unresolved patientIds (from waitlist items):",
      unresolved.map((item) => item.patientId)
    );
    console.warn("[names.js] Sample of cache keys actually available:", cacheKeys.slice(0, 10));
  }

  return enriched;
}
