// calendar-colours.js
// Applies user-defined calendar colours on *.splose.com/calendar pages.
// Runs as a content script; re-applies on DOM changes because Splose's
// calendar is a single-page app that re-renders columns on navigation.

const DEFAULT_AVAILABLE_COLOUR = 'rgb(255, 255, 255)';
const DEFAULT_UNAVAILABLE_COLOUR = 'rgb(240, 241, 242)';

let currentAvailableColour = DEFAULT_AVAILABLE_COLOUR;
let currentUnavailableColour = DEFAULT_UNAVAILABLE_COLOUR;

function hexToRgb(hex) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function applyColours() {
  const cols = document.querySelectorAll('div[class^=_weekDayColumn]');
  if (!cols.length) return;

  cols.forEach((wDay) => {
    if (!wDay.style.background) return;
    wDay.style.background = wDay.style.background
      .replaceAll(DEFAULT_UNAVAILABLE_COLOUR, currentUnavailableColour)
      .replaceAll(DEFAULT_AVAILABLE_COLOUR, currentAvailableColour);
  });
}

function loadColoursAndApply() {
  chrome.storage.local.get(
    { calendarAvailableColour: '#ffffff', calendarUnavailableColour: '#f0f1f2' },
    (settings) => {
      currentAvailableColour = hexToRgb(settings.calendarAvailableColour) || DEFAULT_AVAILABLE_COLOUR;
      currentUnavailableColour = hexToRgb(settings.calendarUnavailableColour) || DEFAULT_UNAVAILABLE_COLOUR;
      applyColours();
    }
  );
}

// Re-apply whenever settings change (e.g. user saves new colours while the tab is open).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.calendarAvailableColour || changes.calendarUnavailableColour) {
    loadColoursAndApply();
  }
});

// Re-apply whenever the calendar re-renders (week navigation, practitioner switch, etc.)
const observer = new MutationObserver(() => applyColours());
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

loadColoursAndApply();