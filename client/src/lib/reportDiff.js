// Pure helpers for comparing two issue inventories ("since your last run").
// No JSX/DOM imports: the server test suite imports this module directly.

const EXCERPT_PREFIX_WORDS = 6;
const TRACKED_STATUSES = new Set(["warning", "fail", "info"]);

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function stripDigits(value) {
  return normalizeText(String(value ?? "").replace(/\d+/g, " "));
}

// First words of the flagged excerpt, normalized. Stored runs keep only this
// prefix so localStorage stays small while identities remain comparable.
export function excerptPrefix(value) {
  return normalizeText(value).split(" ").slice(0, EXCERPT_PREFIX_WORDS).join(" ");
}

function issueLocationKey(issue) {
  const excerpt = issue?.location?.excerpt ?? issue?.evidence ?? issue?.excerptPrefix ?? "";
  const label = issue?.location?.label ?? issue?.locationLabel ?? "";

  // Prefer the excerpt: it names the offending text itself, so the identity
  // survives line renumbering. Fall back to the digit-stripped label.
  return excerptPrefix(excerpt) || stripDigits(label);
}

// Identity-key design: sectionId + digit-stripped title + location key, where
// the location key is the first words of the flagged excerpt (falling back to
// the location label with digits removed, e.g. "Body line 42" -> "body line").
//
// Tradeoff: line numbers are the most precise coordinate but the least stable
// across edits — fixing two issues on page 1 renumbers every later line, which
// would mark every downstream issue "fixed" and "new". The excerpt prefix is
// anchored to the flagged text instead, so an untouched issue keeps its
// identity no matter how far it moves. The cost: editing the flagged sentence
// itself changes the identity, so a persisting-but-edited issue counts as
// resolved + added. That is acceptable — editing the flagged text usually IS
// the fix, and when the edit did not fix it, surfacing it as "new" invites
// another look. Digits are stripped from titles/labels so entry or line
// numbers embedded there ("Reference entry 3 ...") do not break identity when
// entries shift position.
export function issueIdentity(issue) {
  return [normalizeText(issue?.sectionId), stripDigits(issue?.title), issueLocationKey(issue)].join("|");
}

function trackedIssues(issues) {
  return (Array.isArray(issues) ? issues : []).filter((issue) => TRACKED_STATUSES.has(issue?.status));
}

// Partitions the two inventories by issue identity. Only actionable issues
// (warning/fail/info) participate; "pass" findings are ignored.
export function diffInventories(previousIssues, currentIssues) {
  const previous = trackedIssues(previousIssues).map((issue) => ({ issue, identity: issueIdentity(issue) }));
  const current = trackedIssues(currentIssues).map((issue) => ({ issue, identity: issueIdentity(issue) }));
  const previousIdentities = new Set(previous.map((entry) => entry.identity));
  const currentIdentities = new Set(current.map((entry) => entry.identity));

  return {
    resolved: previous.filter((entry) => !currentIdentities.has(entry.identity)).map((entry) => entry.issue),
    added: current.filter((entry) => !previousIdentities.has(entry.identity)).map((entry) => entry.issue),
    persisting: current.filter((entry) => previousIdentities.has(entry.identity)).map((entry) => entry.issue),
  };
}

export function summarizeDiff(diff) {
  const resolvedCount = diff?.resolved?.length ?? 0;
  const addedCount = diff?.added?.length ?? 0;
  const persistingCount = diff?.persisting?.length ?? 0;

  if (resolvedCount === 0 && addedCount === 0 && persistingCount === 0) {
    return "No issues in this run or your last run";
  }

  const tail = `${addedCount} new, ${persistingCount} remaining`;

  if (resolvedCount === 0) {
    return `No issues fixed since your last run — ${tail}`;
  }

  return `Fixed ${resolvedCount} issue${resolvedCount === 1 ? "" : "s"} since your last run — ${tail}`;
}
