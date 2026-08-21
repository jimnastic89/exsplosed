// config.js
// Central place for reading/writing extension settings and the API key.
//
// A NOTE ON "SECURE STORAGE":
// Chrome extensions don't have access to the OS keychain, so there is no
// way to get true encryption-at-rest for a key from inside an extension.
// What we *can* guarantee:
//   - chrome.storage.local is isolated per-extension. Web pages (including
//     Splose itself) cannot read it, and other extensions cannot read it.
//   - It never touches source control, sync servers, or the page DOM.
//   - It is not chrome.storage.sync, so the key never leaves the machine.
// That's the realistic ceiling for a pure browser extension. If you need
// stronger guarantees later (e.g. per-clinician keys with central
// revocation), that points towards a small backing service issuing
// short-lived tokens rather than anything doable purely client-side.
//
// We default to chrome.storage.local (survives browser restarts, so
// reception doesn't have to re-enter the key every morning). If you'd
// rather the key only live in memory for the session, flip
// PERSIST_API_KEY to false and it will use chrome.storage.session instead.

const PERSIST_API_KEY = true;
const keyStore = PERSIST_API_KEY ? chrome.storage.local : chrome.storage.session;

export const DEFAULTS = {
  // NOTE: the Splose API itself is a single fixed host (api.splose.com),
  // confirmed via the OpenAPI spec — the API key alone identifies your
  // workspace. `subdomain` is only used to build the clickable web-app
  // link to an invoice (https://<subdomain>.splose.com/invoices/<id>/view),
  // which is a separate assumption carried over from the original brief
  // and wasn't part of the API spec — worth confirming against one real
  // invoice link in your browser.
  subdomain: "",           // e.g. "acmeclinic" -> https://acmeclinic.splose.com
  ageThresholdDays: 7,     // only flag invoices this many days past due
  pollIntervalMinutes: 15, // chrome.alarms minimum practical interval
  notifyCadenceHours: 24,  // minimum gap between reminder toasts per invoice
  escalateAfterDays: 14,   // start escalating tone/frequency past this age
  role: "reception",       // "reception" | "clinician" (future scoping hook)
  scopeContactIds: [],     // future: restrict clinician view to their patients
  maxNotificationsPerPoll: 8,   // cap on individual toasts fired in one poll before folding the rest into a digest
  maxPatientLookupsPerPoll: 10, // cap on serial live /patients/{id} fallback calls in one poll before forcing a cache rebuild
  calendarAvailableColour: "#ffffff",
  calendarUnavailableColour: "f0f1f2",
};

export async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const { apiKey } = await keyStore.get("apiKey");
  return { ...DEFAULTS, ...stored, apiKey: apiKey || "" };
}

export async function setConfig(partial) {
  const { apiKey, ...rest } = partial;
  if (Object.keys(rest).length) {
    await chrome.storage.local.set(rest);
  }
  if (apiKey !== undefined) {
    if (apiKey) {
      await keyStore.set({ apiKey });
    } else {
      await keyStore.remove("apiKey");
    }
  }
}

// Builds the human-facing link to an invoice in the Splose web app. This
// format (https://<subdomain>.splose.com/invoices/<id>/view) is carried
// over from the original brief, not from the API spec — sanity-check it
// against one real invoice link before relying on it.
export function invoiceUrl(subdomain, invoiceId) {
  return `https://${subdomain}.splose.com/invoices/${invoiceId}/view`;
}

export function patientDetailsUrl(subdomain, patientId) {
  return `https://${subdomain}.splose.com/patients/${patientId}/details`;
}
