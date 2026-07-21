import { excerptPrefix } from "./reportDiff.js";

// Local, per-browser memory of the previous run for each filename so the app
// can show what changed between uploads. Only the latest run per filename is
// kept, storage failures (private mode, quota) are swallowed, and issues are
// stored in a minimal shape capped at MAX_STORED_ISSUES.
const STORAGE_PREFIX = "apa-review-history:";
const MAX_STORED_ISSUES = 300;

function storageKey(filename) {
  return `${STORAGE_PREFIX}${filename}`;
}

function getStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function toStoredIssues(issues) {
  return (Array.isArray(issues) ? issues : []).slice(0, MAX_STORED_ISSUES).map((issue) => ({
    sectionId: issue.sectionId ?? "",
    title: issue.title ?? "",
    status: issue.status ?? "",
    locationLabel: issue.location?.label ?? "",
    excerptPrefix: excerptPrefix(issue.location?.excerpt ?? issue.evidence ?? ""),
  }));
}

export function saveRun(filename, { timestamp, issues }) {
  const storage = getStorage();

  if (!storage || !filename) {
    return;
  }

  try {
    storage.setItem(
      storageKey(filename),
      JSON.stringify({
        timestamp: timestamp ?? new Date().toISOString(),
        issues: (Array.isArray(issues) ? issues : []).slice(0, MAX_STORED_ISSUES),
      }),
    );
  } catch {
    // Storage may be unavailable or full; run history is best-effort only.
  }
}

export function loadPreviousRun(filename) {
  const storage = getStorage();

  if (!storage || !filename) {
    return null;
  }

  try {
    const raw = storage.getItem(storageKey(filename));

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);

    if (!parsed || !Array.isArray(parsed.issues)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
