// api.js
// Thin client for the Splose API, matched against the OpenAPI spec you
// provided. Key confirmed facts that shaped this file:
//
// - Fixed API host for everyone: https://api.splose.com/v1 — NOT a
//   per-business subdomain. (The business subdomain, e.g.
//   https://<business>.splose.com, is a separate thing: it's the web app
//   URL used to build a clickable link to an invoice. That format wasn't
//   in this spec, so it's still an assumption carried over from the
//   original brief — worth a quick sanity check against a real invoice
//   link before relying on it.)
// - Auth: `Authorization: Bearer <api_key>`.
// - Pagination is cursor-based: `id_gt` / `id_lt`, not page numbers. The
//   response includes a `links.previousPage`/`links.nextPage` pair, but
//   Splose's own doc has their descriptions swapped relative to their
//   example values, and doesn't state a default sort direction — so
//   `paginate()` below detects direction from the first page's own
//   ordering rather than assuming ascending-by-id (an earlier version of
//   this file assumed ascending, which silently dropped everything past
//   the first page on any endpoint that actually defaults to
//   descending/newest-first — e.g. was causing "Unknown patient" for
//   older patients).
// - Invoice `status` enum is only `Draft` / `Awaiting Payment` / `Paid` —
//   there's no "overdue" status. We filter server-side for
//   `Awaiting Payment` and apply our own age-since-due-date threshold
//   client-side, same as originally designed.
// - No `amount_due` field: it's `total - paidAmount`.
// - No currency field on the invoice. Splose is AU-focused (NDIS/allied
//   health), so AUD is a reasonable default, but it's an inference, not
//   something the spec states — flagged here rather than presented as
//   confirmed.
// - No contact/client name on the invoice — just `patientId` and a
//   nullable `contactId` (who's actually billed, if not the patient).
//   Resolving a display name means a separate lookup against
//   `/patients` / `/contacts`; see names.js for how that's cached instead
//   of hitting those endpoints on every poll.
//
// USER-AGENT: Chrome blocks `fetch()` from setting a User-Agent header
// directly (it's a "forbidden header name" per the Fetch spec, enforced
// regardless of what you pass). background.js installs a
// declarativeNetRequest rule that rewrites the outgoing User-Agent for
// requests to api.splose.com/v1/* instead — don't try to set it here, it
// will be silently dropped.

const API_BASE = "https://api.splose.com/v1";

export class RateLimitError extends Error {}

async function apiGet(path, { apiKey }, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    throw new RateLimitError("Splose API rate limit hit (429).");
  }
  if (!res.ok) {
    throw new Error(`Splose API error ${res.status} on ${path}: ${await safeText(res)}`);
  }

  return res.json();
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}

function normalizeInvoice(raw) {
  const amountDue =
    typeof raw.total === "number" && typeof raw.paidAmount === "number"
      ? Math.max(0, raw.total - raw.paidAmount)
      : raw.total ?? null;

  return {
    id: String(raw.id),
    number: raw.invoiceNumber ?? String(raw.id),
    status: raw.status, // "Draft" | "Awaiting Payment" | "Paid"
    dueDate: raw.dueDate ? new Date(raw.dueDate).toISOString() : null,
    issuedDate: raw.issueDate ? new Date(raw.issueDate).toISOString() : null,
    total: raw.total ?? null,
    paidAmount: raw.paidAmount ?? null,
    amountDue,
    currency: "AUD", // inferred, not a field in the API — see note above
    patientId: raw.patientId != null ? String(raw.patientId) : null,
    contactId: raw.contactId != null ? String(raw.contactId) : null,
  };
}

/**
 * Fetches every page of a cursor-paginated list endpoint (/invoices,
 * /patients, /contacts, /practitioners, /waitlists), applying extra static
 * query params (e.g. { status: "Awaiting Payment" }) to every page.
 *
 * IMPORTANT — sort direction is NOT assumed, it's detected:
 * Splose's own docs are self-contradictory about whether results come
 * back ascending or descending by id by default (previousPage/nextPage
 * descriptions are swapped relative to their examples). Assuming
 * ascending and always walking forward with `id_gt=max(ids seen)` is
 * actively wrong if the real default is descending (newest-first): the
 * first page would already contain the highest ids, so `id_gt=max` would
 * match nothing, and the loop would silently stop after one page —
 * quietly dropping every older record. That's the exact bug this fixed:
 * only the most-recent page of patients was ever being cached, so anyone
 * older showed up as "Unknown patient".
 *
 * Instead: look at the first page's own order. If it's ascending, keep
 * walking forward with `id_gt` + the max id seen. If it's descending (or
 * a single item, where direction can't be inferred — arbitrarily walk
 * forward, it'll just stop after one page if that's genuinely all there
 * is), walk backward with `id_lt` + the min id seen.
 */
async function paginate(path, { apiKey }, extraParams = {}) {
  const all = [];
  let cursorParam = null; // "id_gt" | "id_lt", decided after the first page
  let cursorValue;
  let iterations = 0;
  const maxIterations = 500; // safety valve against a pagination bug looping forever

  while (iterations < maxIterations) {
    iterations += 1;
    const params = { ...extraParams };
    if (cursorParam) params[cursorParam] = cursorValue;

    const body = await apiGet(path, { apiKey }, params);
    const items = body.data ?? [];
    if (items.length === 0) break;

    all.push(...items);

    if (!cursorParam) {
      const firstId = items[0].id;
      const lastId = items[items.length - 1].id;
      cursorParam = lastId < firstId ? "id_lt" : "id_gt";
    }

    cursorValue =
      cursorParam === "id_gt" ? Math.max(...items.map((i) => i.id)) : Math.min(...items.map((i) => i.id));
  }

  return all;
}

/**
 * Fetches every "Awaiting Payment" invoice via cursor pagination.
 * Sequential (not parallel) requests by design — Splose's 60/min limit and
 * the 1s-average-latency rule both reward gentle, predictable traffic over
 * a burst of concurrent calls. Filtering server-side by status also means
 * we're only ever paginating through genuinely unpaid invoices, not the
 * whole ledger.
 */
export async function fetchAllUnpaidInvoices({ apiKey }) {
  const raw = await paginate("/invoices", { apiKey }, { status: "Awaiting Payment" });
  return raw.map(normalizeInvoice);
}

/**
 * Fetches every page of a cursor-paginated list endpoint (e.g. /patients,
 * /contacts, /practitioners, /waitlists), optionally with extra static
 * query params (e.g. { isActive: "true" }) applied to every page.
 */
export async function fetchAllPages(path, { apiKey }, extraParams = {}) {
  return paginate(path, { apiKey }, extraParams);
}

function normalizeWaitlistItem(raw) {
  return {
    id: String(raw.id),
    patientId: raw.patientId != null ? String(raw.patientId) : null,
    practitionerId: raw.practitionerId != null ? String(raw.practitionerId) : null,
    // No explicit "date added" field in the response schema (only
    // createdAt/updatedAt), even though the API accepts dateAddedGt/Lt as
    // query filters — using createdAt as a stand-in for "waiting since".
    waitingSince: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
    // Full day names ("Monday".."Sunday") and a subset of
    // "morning"/"afternoon"/"evening" — both nullable/absent if the
    // patient has no preference set.
    preferredDays: Array.isArray(raw.preferredDays) ? raw.preferredDays : [],
    preferredTime: Array.isArray(raw.preferredTime) ? raw.preferredTime : [],
  };
}

/**
 * Fetches every currently-active (non-archived) waitlist entry.
 */
export async function fetchActiveWaitlist({ apiKey }) {
  const raw = await fetchAllPages("/waitlists", { apiKey }, { isActive: "true" });
  return raw.map(normalizeWaitlistItem);
}

export async function fetchPatientById({ apiKey }, patientId) {
  try {
    const response = await apiGet(`/patients/${patientId}`, { apiKey });
    return response.data ?? response;
  } catch (err) {
    console.error(`Failed to fetch patient ID ${patientId}`, err);
    return null;
  }
}