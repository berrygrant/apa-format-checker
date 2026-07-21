import { buildSection, makeFinding, makeItemIssue, makeLocation } from "./ruleChecks.js";

// Run-level formatting checks for DOCX uploads: psychology thesis rubrics care
// about italicized statistical symbols in the body and italicized journal/book
// titles in the reference list. Both analyzers are pure functions over the
// parsed document and the run facts produced by extractDocxLayout, and both
// return `{ findings: [], itemIssues: [] }` for PDFs or when run facts are
// unavailable so reviewJob can merge them unconditionally.

// Statistical symbols APA 7 italicizes when they report values ("p = .03",
// "t(34) = 2.10", "M = 4.2, SD = 1.1"). The match is case-sensitive (P, D,
// etc. are not APA statistics symbols), the lookbehind rejects symbols glued
// to a preceding letter or digit ("pH = 7", "VAR2 = 3"), and the optional
// short parenthetical admits degrees of freedom.
const STATISTIC_PATTERN_REGEX = /(?<![A-Za-z0-9])(SD|SE|R2|[ptFrMNnd])(\s*\([^()]{0,24}\))?\s*[=<>]/g;
const STATISTIC_ISSUE_CAP = 20;

const REFERENCE_ITALICS_ISSUE_CAP = 15;
const REFERENCE_ENTRY_MIN_WORDS = 8;
const REFERENCE_ITALIC_SPAN_MIN_WORDS = 2;
// Only paragraphs that look like actual reference entries (a year or n.d.
// parenthetical) are scanned, so appendix prose after the reference list does
// not produce false "missing italics" warnings.
const REFERENCE_ENTRY_YEAR_REGEX = /\((?:(?:19|20)\d{2}[a-z]?|n\.d\.)\)/;

function countWords(text) {
  return String(text || "")
    .split(/\s+/)
    .filter(Boolean).length;
}

function shorten(text, maxLength = 60) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeForLookup(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Run facts carry no line numbers, so locations are recovered best-effort by
// matching the paragraph text against the parser's line/entry records.
function buildTextLookup(records, textOf) {
  const lookup = new Map();

  for (const record of records ?? []) {
    const key = normalizeForLookup(textOf(record));

    if (key && !lookup.has(key)) {
      lookup.set(key, record);
    }
  }

  return lookup;
}

function buildRunOffsets(runs) {
  const offsets = [];
  let position = 0;

  for (const run of runs) {
    offsets.push({ start: position, end: position + run.text.length, italic: Boolean(run.italic) });
    position += run.text.length;
  }

  return offsets;
}

// True when every character of [start, end) is covered by an italic run, even
// when the span crosses run boundaries.
function spanIsItalic(offsets, start, end) {
  let position = start;

  while (position < end) {
    const covering = offsets.find((offset) => position >= offset.start && position < offset.end);

    if (!covering?.italic) {
      return false;
    }

    position = covering.end;
  }

  return end > start;
}

function statisticsLocation(lineLookup, paragraph, matchIndex) {
  const lineRecord = lineLookup.get(normalizeForLookup(paragraph.text)) ?? null;
  const excerpt = paragraph.text.slice(Math.max(0, matchIndex - 60), matchIndex + 80);

  return makeLocation({
    sectionId: "body",
    lineStart: lineRecord?.lineNumber ?? null,
    lineEnd: lineRecord?.lineNumber ?? null,
    paragraphNumber: lineRecord?.paragraphNumber ?? null,
    excerpt,
    labelOverride: lineRecord ? null : "Body (run-level scan)",
  });
}

export function analyzeStatisticsFormatting(parsedDocument, runFacts) {
  const empty = { findings: [], itemIssues: [] };

  if (!runFacts || parsedDocument?.sourceFormat !== "docx") {
    return empty;
  }

  const lineLookup = buildTextLookup(parsedDocument.mainLineRecords, (lineRecord) => lineRecord.text);
  let patternCount = 0;
  let nonItalicCount = 0;
  const dedupedIssues = [];

  for (const paragraph of runFacts.mainParagraphs ?? []) {
    if (!paragraph?.runs?.length) {
      continue;
    }

    const offsets = buildRunOffsets(paragraph.runs);
    const seenSymbols = new Set();

    for (const match of paragraph.text.matchAll(STATISTIC_PATTERN_REGEX)) {
      patternCount += 1;
      const symbol = match[1];
      const start = match.index ?? 0;

      if (spanIsItalic(offsets, start, start + symbol.length)) {
        continue;
      }

      nonItalicCount += 1;

      // One issue per symbol per paragraph keeps a results section from
      // flooding the inventory with identical items.
      if (seenSymbols.has(symbol)) {
        continue;
      }

      seenSymbols.add(symbol);
      dedupedIssues.push({ symbol, paragraph, matchIndex: start, context: paragraph.text.slice(start, start + 24) });
    }
  }

  if (patternCount === 0) {
    return empty;
  }

  if (nonItalicCount === 0) {
    return {
      findings: [
        makeFinding(
          "pass",
          "Statistical symbols italicized",
          `All ${patternCount} detected statistical symbol occurrence${patternCount === 1 ? " is" : "s are"} italicized (e.g., p, t, F, M, SD).`,
          "No action required.",
        ),
      ],
      itemIssues: [],
    };
  }

  const visibleIssues = dedupedIssues.slice(0, STATISTIC_ISSUE_CAP);
  const hiddenCount = dedupedIssues.length - visibleIssues.length;
  const itemIssues = visibleIssues.map((issue) =>
    makeItemIssue({
      sectionId: "body",
      sectionLabel: "Body and Headings",
      status: "warning",
      title: "Statistical symbol not italicized",
      detail: `The statistical symbol "${issue.symbol}" is not italicized where it reports a value ("${shorten(issue.context, 32)}").`,
      recommendation: `Italicize "${issue.symbol}"; APA 7 italicizes statistical symbols such as p, t, F, M, and SD.`,
      location: statisticsLocation(lineLookup, issue.paragraph, issue.matchIndex),
    }),
  );

  return {
    findings: [
      makeFinding(
        "warning",
        "Statistical symbols not italicized",
        `${nonItalicCount} of ${patternCount} statistical symbol occurrence${patternCount === 1 ? "" : "s"} ${nonItalicCount === 1 ? "is" : "are"} not italicized${
          hiddenCount > 0 ? ` (${visibleIssues.length} listed; +${hiddenCount} more)` : ""
        }.`,
        "Italicize statistical symbols (p, t, F, r, M, SD, SE, N, n, d, R2) wherever they report values.",
        null,
        itemIssues[0].location,
      ),
    ],
    itemIssues,
  };
}

// An entry "has an italicized title" when some maximal italic span covers at
// least two words. Consecutive italic runs merge, and whitespace-only plain
// runs do not break a span.
function hasItalicTitleSpan(runs) {
  let currentSpan = "";

  for (const run of runs) {
    if (run.italic || (currentSpan && run.text.trim() === "")) {
      currentSpan += run.text;
      continue;
    }

    if (countWords(currentSpan) >= REFERENCE_ITALIC_SPAN_MIN_WORDS) {
      return true;
    }

    currentSpan = "";
  }

  return countWords(currentSpan) >= REFERENCE_ITALIC_SPAN_MIN_WORDS;
}

function referenceEntryLocation(entryLookup, paragraph) {
  const entryRecord = entryLookup.get(normalizeForLookup(paragraph.text)) ?? null;

  return makeLocation({
    sectionId: "references",
    lineStart: entryRecord?.startLine ?? null,
    lineEnd: entryRecord?.endLine ?? null,
    entryNumber: entryRecord?.entryNumber ?? null,
    excerpt: paragraph.text,
    labelOverride: entryRecord ? null : "References entry",
  });
}

export function analyzeReferenceItalics(parsedDocument, runFacts) {
  const empty = { findings: [], itemIssues: [] };

  if (!runFacts || parsedDocument?.sourceFormat !== "docx") {
    return empty;
  }

  const entryLookup = buildTextLookup(parsedDocument.referenceEntryRecords, (entryRecord) => entryRecord.text);
  const entryParagraphs = (runFacts.referenceParagraphs ?? []).filter(
    (paragraph) =>
      paragraph?.runs?.length &&
      countWords(paragraph.text) >= REFERENCE_ENTRY_MIN_WORDS &&
      REFERENCE_ENTRY_YEAR_REGEX.test(paragraph.text),
  );

  if (entryParagraphs.length === 0) {
    return empty;
  }

  const missingItalics = entryParagraphs.filter((paragraph) => !hasItalicTitleSpan(paragraph.runs));

  if (missingItalics.length === 0) {
    return {
      findings: [
        makeFinding(
          "pass",
          "Reference titles italicized",
          `All ${entryParagraphs.length} scanned reference entr${entryParagraphs.length === 1 ? "y contains" : "ies contain"} an italicized title.`,
          "No action required.",
        ),
      ],
      itemIssues: [],
    };
  }

  const visibleIssues = missingItalics.slice(0, REFERENCE_ITALICS_ISSUE_CAP);
  const hiddenCount = missingItalics.length - visibleIssues.length;
  const itemIssues = visibleIssues.map((paragraph) =>
    makeItemIssue({
      sectionId: "references",
      sectionLabel: "References",
      status: "warning",
      title: "Reference entry lacks an italicized title",
      detail: `No italicized journal or book title was detected in "${shorten(paragraph.text, 70)}".`,
      recommendation: "Italicize the periodical name and volume number (or the book title) in APA 7 reference entries.",
      location: referenceEntryLocation(entryLookup, paragraph),
    }),
  );

  return {
    findings: [
      makeFinding(
        "warning",
        "Reference entries missing italicized titles",
        `${missingItalics.length} of ${entryParagraphs.length} scanned reference entr${missingItalics.length === 1 ? "y shows" : "ies show"} no italicized title${
          hiddenCount > 0 ? ` (${visibleIssues.length} listed; +${hiddenCount} more)` : ""
        }.`,
        "Italicize journal names and volume numbers (or book titles) in every reference entry.",
        null,
        itemIssues[0].location,
      ),
    ],
    itemIssues,
  };
}

// Folds extra findings/itemIssues into an analyzer part and rebuilds the
// section so its score and status reflect the merged findings. Returns the
// original part untouched when there is nothing to merge (the PDF/no-layout
// path).
export function mergeAnalyzerResults(part, extraResults) {
  const extras = (extraResults ?? []).filter(Boolean);
  const extraFindings = extras.flatMap((result) => result.findings ?? []);
  const extraItemIssues = extras.flatMap((result) => result.itemIssues ?? []);

  if (extraFindings.length === 0 && extraItemIssues.length === 0) {
    return part;
  }

  const { section } = part;

  return {
    ...part,
    section: buildSection(section.id, section.label, section.summary, [...section.findings, ...extraFindings], section.metrics),
    itemIssues: [...part.itemIssues, ...extraItemIssues],
  };
}
