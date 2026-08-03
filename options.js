import { getConfig, setConfig } from "./config.js";

const form = document.getElementById("settingsForm");
const saveStatus = document.getElementById("saveStatus");

const fields = {
  subdomain: document.getElementById("subdomain"),
  apiKey: document.getElementById("apiKey"),
  ageThresholdDays: document.getElementById("ageThresholdDays"),
  escalateAfterDays: document.getElementById("escalateAfterDays"),
  pollIntervalMinutes: document.getElementById("pollIntervalMinutes"),
  notifyCadenceHours: document.getElementById("notifyCadenceHours"),
  role: document.getElementById("role"),
  maxNotificationsPerPoll: document.getElementById("maxNotificationsPerPoll"),
  maxPatientLookupsPerPoll: document.getElementById("maxPatientLookupsPerPoll"),
};

async function load() {
  const config = await getConfig();
  fields.subdomain.value = config.subdomain;
  // Deliberately not pre-filling apiKey with the real stored value in the
  // password field — showing a placeholder avoids ever rendering the raw
  // key back into the DOM after it's been saved once.
  fields.apiKey.placeholder = config.apiKey ? "•••••••• (already saved — leave blank to keep it)" : "Paste your Splose API key";
  fields.ageThresholdDays.value = config.ageThresholdDays;
  fields.escalateAfterDays.value = config.escalateAfterDays;
  fields.pollIntervalMinutes.value = String(config.pollIntervalMinutes);
  fields.notifyCadenceHours.value = String(config.notifyCadenceHours);
  fields.role.value = config.role;
  fields.maxNotificationsPerPoll.value = config.maxNotificationsPerPoll;
  fields.maxPatientLookupsPerPoll.value = config.maxPatientLookupsPerPoll;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const partial = {
    subdomain: fields.subdomain.value.trim().replace(/^https?:\/\//, "").replace(/\.splose\.com.*$/, ""),
    ageThresholdDays: Number(fields.ageThresholdDays.value),
    escalateAfterDays: Number(fields.escalateAfterDays.value),
    pollIntervalMinutes: Number(fields.pollIntervalMinutes.value),
    notifyCadenceHours: Number(fields.notifyCadenceHours.value),
    role: fields.role.value,
    maxNotificationsPerPoll: Number(fields.maxNotificationsPerPoll.value),
    maxPatientLookupsPerPoll: Number(fields.maxPatientLookupsPerPoll.value),
  };

  // Only touch the stored API key if the user actually typed a new one.
  if (fields.apiKey.value.trim()) {
    partial.apiKey = fields.apiKey.value.trim();
  }

  await setConfig(partial);
  fields.apiKey.value = "";
  await load();

  saveStatus.textContent = "Saved — checking now…";
  chrome.runtime.sendMessage({ type: "POLL_NOW" }, () => {
    saveStatus.textContent = "Saved and up to date.";
    setTimeout(() => (saveStatus.textContent = ""), 3000);
  });
});

load();
