import {
  CROSSREF_MAILTO,
  CROSSREF_TIMEOUT_MS,
  CROSSREF_TOTAL_BUDGET_MS,
  REFERENCE_VERIFICATION_ENABLED,
} from "./config.js";
import { buildSection, makeFinding, makeItemIssue } from "./ruleChecks.js";

const CROSSREF_API_BASE = "https://api.crossref.org/works/";
const DOI_REGEX = /\b10\.\d{4,9}\/[^\s"<>]+/;
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?)\]}>'"\u2019\u201d]+$/;
const DEFAULT_CONCURRENCY = 4;
// Share of (unique) CrossRef-title tokens that must appear in the entry text
// for the titles to be treated as the same work.
const TITLE_MATCH_THRESHOLD = 0.5;
const BUDGET_EXHAUSTED_DETAIL = "time budget exhausted";

export function extractDoi(rawText) {
  const match = String(rawText || "").match(DOI_REGEX);

  if (!match) {
    return null;
  }

  const doi = match[0].replace(TRAILING_PUNCTUATION_REGEX, "");
  return doi || null;
}

function tokenizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

// Containment ratio: how many of the CrossRef title's tokens also appear in
// the reference entry text. The entry text is a superset (authors, journal,
// pages), so containment is more robust than symmetric Jaccard here.
function titleOverlapRatio(crossrefTitle, entryText) {
  const titleTokens = [...new Set(tokenizeTitle(crossrefTitle))];

  if (titleTokens.length === 0) {
    return 1;
  }

  const entryTokens = new Set(tokenizeTitle(entryText));
  const sharedCount = titleTokens.filter((token) => entryTokens.has(token)).length;
  return sharedCount / titleTokens.length;
}

function readDatePartsYear(dateField) {
  const year = dateField?.["date-parts"]?.[0]?.[0];
  return Number.isInteger(year) ? year : null;
}

// Preference order mirrors CrossRef semantics: issued, then print, then
// online. An entry year matching ANY of them counts as correct, because APA
// authors may legitimately cite either the online-first or print year.
function extractCrossrefYears(message) {
  return [
    readDatePartsYear(message?.issued),
    readDatePartsYear(message?.["published-print"]),
    readDatePartsYear(message?.["published-online"]),
  ].filter((year, index, years) => year !== null && years.indexOf(year) === index);
}

function firstString(value) {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }

  return typeof value === "string" ? value : "";
}

function parseEntryYear(year) {
  const match = String(year || "").match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function queryCrossref({ doi, fetchImpl, timeoutMs, mailto }) {
  const url = new URL(`${CROSSREF_API_BASE}${encodeURIComponent(doi)}`);

  if (mailto) {
    url.searchParams.set("mailto", mailto);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url.toString(), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (response.status === 404) {
      return { kind: "not_found" };
    }

    if (!response.ok) {
      return { kind: "http_error", statusCode: response.status };
    }

    const payload = await response.json();
    return { kind: "ok", message: payload?.message ?? {} };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { kind: "timeout" };
    }

    return { kind: "network_error", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function compareEntryToCrossref(pair, message) {
  const crossrefTitle = firstString(message?.title);
  const crossrefYears = extractCrossrefYears(message);
  const crossref = {
    title: crossrefTitle || null,
    year: crossrefYears[0] ?? null,
    containerTitle: firstString(message?.["container-title"]) || null,
  };
  const entryYear = parseEntryYear(pair.year);

  if (entryYear !== null && crossrefYears.length > 0 && !crossrefYears.includes(entryYear)) {
    return {
      outcome: "year_mismatch",
      crossref,
      detail: `CrossRef reports ${crossrefYears.join(" or ")} as the publication year for this DOI, but the entry cites ${entryYear}.`,
    };
  }

  const overlap = titleOverlapRatio(crossrefTitle, pair.raw);

  if (overlap < TITLE_MATCH_THRESHOLD) {
    return {
      outcome: "title_mismatch",
      crossref,
      detail: `CrossRef reports the title "${crossrefTitle}" for this DOI, which does not match this entry's wording.`,
    };
  }

  return {
    outcome: "verified",
    crossref,
    detail: "The CrossRef record for this DOI matches the entry's year and title.",
  };
}

async function verifyOne(task, { fetchImpl, timeoutMs, mailto }) {
  const base = { entryNumber: task.pair.entryNumber ?? null, doi: task.doi };
  const response = await queryCrossref({ doi: task.doi, fetchImpl, timeoutMs, mailto });

  switch (response.kind) {
    case "not_found":
      return { ...base, outcome: "not_found", crossref: null, detail: `CrossRef has no record for DOI ${task.doi}.` };
    case "timeout":
      return { ...base, outcome: "error", crossref: null, detail: `CrossRef request timed out after ${timeoutMs}ms.` };
    case "http_error":
      return { ...base, outcome: "error", crossref: null, detail: `CrossRef request failed with HTTP ${response.statusCode}.` };
    case "network_error":
      return { ...base, outcome: "error", crossref: null, detail: `CrossRef request failed: ${response.detail}` };
    default:
      return { ...base, ...compareEntryToCrossref(task.pair, response.message) };
  }
}

/**
 * Verifies DOI-bearing reference entries against the public CrossRef API.
 * Designed to degrade gracefully like the OpenAI stage: offline, timeout, or
 * disabled states resolve to informational results and never throw.
 */
export async function verifyReferences(referencePairs, options = {}) {
  const {
    enabled = REFERENCE_VERIFICATION_ENABLED,
    fetchImpl = globalThis.fetch,
    timeoutMs = CROSSREF_TIMEOUT_MS,
    totalBudgetMs = CROSSREF_TOTAL_BUDGET_MS,
    mailto = CROSSREF_MAILTO,
    concurrency = DEFAULT_CONCURRENCY,
  } = options;
  const pairs = Array.isArray(referencePairs) ? referencePairs : [];
  const base = {
    checked: 0,
    verified: 0,
    mismatched: 0,
    unresolved: 0,
    errored: 0,
    totalEntries: pairs.length,
    withoutDoi: 0,
    results: [],
  };

  if (!enabled || pairs.length === 0) {
    return {
      status: "skipped",
      ...base,
      message: enabled
        ? "No reference entries were extracted, so CrossRef verification was skipped."
        : "Reference verification is disabled (REFERENCE_VERIFICATION=off).",
    };
  }

  const tasks = [];
  let withoutDoi = 0;

  for (const pair of pairs) {
    const doi = extractDoi(pair.raw);

    if (doi) {
      tasks.push({ pair, doi, index: tasks.length });
    } else {
      withoutDoi += 1;
    }
  }

  if (tasks.length === 0) {
    return {
      status: "completed",
      ...base,
      withoutDoi,
      message: "None of the extracted reference entries contain a DOI, so no CrossRef lookups were possible.",
    };
  }

  const results = new Array(tasks.length);
  const queue = [...tasks];
  const startedAt = Date.now();

  async function worker() {
    while (queue.length > 0) {
      if (Date.now() - startedAt >= totalBudgetMs) {
        while (queue.length > 0) {
          const task = queue.shift();
          results[task.index] = {
            entryNumber: task.pair.entryNumber ?? null,
            doi: task.doi,
            outcome: "error",
            crossref: null,
            detail: BUDGET_EXHAUSTED_DETAIL,
          };
        }
        return;
      }

      const task = queue.shift();
      results[task.index] = await verifyOne(task, { fetchImpl, timeoutMs, mailto });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

  const verified = results.filter((result) => result.outcome === "verified").length;
  const mismatched = results.filter(
    (result) => result.outcome === "year_mismatch" || result.outcome === "title_mismatch",
  ).length;
  const unresolved = results.filter((result) => result.outcome === "not_found").length;
  const errored = results.filter((result) => result.outcome === "error").length;
  const status = errored === results.length ? "unavailable" : "completed";

  return {
    status,
    checked: results.length,
    verified,
    mismatched,
    unresolved,
    errored,
    totalEntries: pairs.length,
    withoutDoi,
    results,
    message:
      status === "unavailable"
        ? "CrossRef could not be reached, so reference entries were not verified."
        : `Verified ${verified} of ${results.length} DOI-bearing reference entries against CrossRef.`,
  };
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function describeCoverage(verification) {
  return verification.withoutDoi > 0
    ? ` Only DOI-bearing entries are verified; ${pluralize(verification.withoutDoi, "entry", "entries")} without a DOI ${
        verification.withoutDoi === 1 ? "was" : "were"
      } not checked.`
    : "";
}

/**
 * Folds a completed/unavailable verification result back into the references
 * analyzer part: appends section findings plus per-entry item issues, then
 * rebuilds the section status/score while keeping the original summary text.
 * A "skipped" verification returns the part untouched.
 */
export function applyVerificationToReferencesPart(referencesPart, verification, referencePairs = []) {
  if (!verification || verification.status === "skipped") {
    return referencesPart;
  }

  const locationByEntryNumber = new Map(
    referencePairs
      .filter((pair) => pair.entryNumber !== null && pair.entryNumber !== undefined)
      .map((pair) => [pair.entryNumber, pair.location ?? null]),
  );
  const findings = [...referencesPart.section.findings];
  const itemIssues = [...referencesPart.itemIssues];

  if (verification.status === "unavailable") {
    findings.push(
      makeFinding(
        "info",
        "Reference verification unavailable (network)",
        "CrossRef could not be reached, so DOI-bearing reference entries were not verified against external records.",
        "Re-run the review with network access, or spot-check DOIs manually at https://doi.org/.",
      ),
    );
  } else if (verification.checked === 0) {
    findings.push(
      makeFinding(
        "info",
        "No DOI-bearing references to verify",
        `None of the ${pluralize(verification.totalEntries, "extracted reference entry", "extracted reference entries")} contain a DOI, so no entries could be checked against CrossRef. Only DOI-bearing entries are verified.`,
        "No action required; add DOIs where publishers provide them to make entries externally verifiable.",
      ),
    );
  } else {
    const notFoundResults = verification.results.filter((result) => result.outcome === "not_found");
    const mismatchResults = verification.results.filter(
      (result) => result.outcome === "year_mismatch" || result.outcome === "title_mismatch",
    );

    for (const result of notFoundResults) {
      itemIssues.push(
        makeItemIssue({
          sectionId: "references",
          sectionLabel: "References",
          status: "fail",
          title: "DOI does not resolve",
          detail: result.detail,
          recommendation:
            "Check the DOI for typos — or verify this source exists; unresolvable DOIs are a hallmark of fabricated references.",
          location: locationByEntryNumber.get(result.entryNumber) ?? null,
        }),
      );
    }

    for (const result of mismatchResults) {
      const isYearMismatch = result.outcome === "year_mismatch";

      itemIssues.push(
        makeItemIssue({
          sectionId: "references",
          sectionLabel: "References",
          status: "warning",
          title: isYearMismatch ? "Reference year differs from CrossRef" : "Reference title differs from CrossRef",
          detail: result.detail,
          recommendation: isYearMismatch
            ? "Confirm the publication year against the source and update the entry (and its in-text citations) if needed."
            : "Confirm the DOI points at the intended work, then correct either the entry or the DOI.",
          location: locationByEntryNumber.get(result.entryNumber) ?? null,
        }),
      );
    }

    const countsDetail = `Checked ${pluralize(verification.checked, "DOI-bearing entry", "DOI-bearing entries")}: ${verification.verified} verified, ${verification.mismatched} with metadata mismatches, ${verification.unresolved} unresolvable, ${verification.errored} unreachable.${describeCoverage(verification)}`;

    if (notFoundResults.length > 0) {
      findings.push(
        makeFinding(
          "fail",
          "Unresolvable DOIs in references",
          `${pluralize(notFoundResults.length, "reference DOI")} did not resolve at CrossRef. ${countsDetail}`,
          "Correct any mistyped DOIs and verify that each flagged source exists; unresolvable DOIs are a hallmark of fabricated references.",
          null,
          locationByEntryNumber.get(notFoundResults[0].entryNumber) ?? null,
        ),
      );
    } else if (mismatchResults.length > 0) {
      findings.push(
        makeFinding(
          "warning",
          "CrossRef metadata differs for some references",
          `${pluralize(mismatchResults.length, "reference entry", "reference entries")} did not match the CrossRef record for the cited DOI. ${countsDetail}`,
          "Compare each flagged entry with what CrossRef reports and correct the year, title, or DOI.",
          null,
          locationByEntryNumber.get(mismatchResults[0].entryNumber) ?? null,
        ),
      );
    } else if (verification.errored > 0) {
      findings.push(
        makeFinding(
          "info",
          "Reference verification partially completed",
          `${countsDetail} Entries marked unreachable could not be checked before the network time budget ran out.`,
          "No action required; re-run the review to verify the remaining entries.",
        ),
      );
    } else {
      findings.push(
        makeFinding(
          "pass",
          "References verified against CrossRef",
          countsDetail,
          "No action required.",
        ),
      );
    }
  }

  const section = buildSection(
    referencesPart.section.id,
    referencesPart.section.label,
    referencesPart.section.summary,
    findings,
    {
      ...referencesPart.section.metrics,
      verificationStatus: verification.status,
      verificationChecked: verification.checked,
      verificationVerified: verification.verified,
      verificationMismatched: verification.mismatched,
      verificationUnresolved: verification.unresolved,
    },
  );

  return { section, itemIssues };
}
