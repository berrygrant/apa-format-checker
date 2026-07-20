const STATUS_RANK = {
  info: 0,
  pass: 1,
  warning: 2,
  fail: 3,
};

const SECTION_ORDER = ["document", "titlePage", "body", "citations", "references"];

const SECTION_LABELS = {
  document: "Document",
  titlePage: "Title Page",
  body: "Body",
  citations: "Citations",
  references: "References",
};

const HEADING_PATTERNS = [
  { label: "Abstract", regex: /^\s*abstract\s*$/im },
  { label: "Introduction", regex: /^\s*introduction\s*$/im },
  { label: "Literature Review", regex: /^\s*(?:literature review|background)\s*$/im },
  { label: "Method", regex: /^\s*(?:methods?|methodology|materials and methods)\s*$/im },
  { label: "Results", regex: /^\s*(?:results(?:\s+and\s+discussion)?|findings)\s*$/im },
  { label: "Discussion", regex: /^\s*(?:general\s+)?discussion\s*$/im },
  { label: "Conclusion", regex: /^\s*conclusions?\s*$/im },
];

// APA 7 student title pages carry title, author, affiliation, course,
// instructor, and due date — not a "by" line (that is dissertation-cover
// style, not APA).
const TITLE_PAGE_CUES = [
  {
    id: "affiliation",
    label: "author affiliation (department and university)",
    regex: /\b(?:department|school|college|faculty)\s+of\b|\buniversity\b|\bcollege\b|\binstitute\b/i,
  },
  {
    id: "course",
    label: "course number",
    regex: /\b[A-Z]{2,5}\s?-?\d{3,4}\b/,
  },
  {
    id: "instructor",
    label: "instructor name",
    regex: /\b(?:professor|prof\.|dr\.|instructor)\b/i,
  },
  {
    id: "date",
    label: "due date",
    regex: /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}\b/i,
  },
  {
    id: "submission",
    label: "thesis submission wording",
    regex: /\bsubmitted\b|\bin partial fulfillment\b|\bthesis\b|\bdissertation\b/i,
  },
];

const AUTHOR_PHRASE_PATTERN =
  "[A-Z][A-Za-z'`-]*(?:\\s+(?:[A-Z][A-Za-z'`-]*|van|von|de|del|der|da|di|la|le|du|den|&|and|et\\s+al\\.?))*?";
const CITATION_LEAD_IN_PATTERN = [
  "according to",
  "as noted by",
  "as argued by",
  "as discussed by",
  "but see",
  "see also",
  "see generally",
  "see",
  "cf\\.?",
  "compare",
  "for example",
  "for instance",
  "e\\.g\\.?",
  "inter alia",
  "etc\\.?",
  "contra",
].join("|");
const PARENTHETICAL_GROUP_REGEX = /\(([^()]+)\)/g;
const CITATION_YEAR_PATTERN = "(?:(?:19|20)\\d{2}[a-z]?|n\\.d\\.)";
const CITATION_LOCATOR_PATTERN = "(?:pp?\\.|paras?\\.)\\s*\\d+(?:\\s*[-\\u2013\\u2014]\\s*\\d+)?";
// Anchored shape for one semicolon-separated parenthetical candidate. Unlike a
// bare "any parenthetical containing a year" match, this demands an author-like
// phrase in front of the year so "(the 2008 recession)" is not read as a
// citation. Lowercase connectors (of/the/for/...) admit organizational authors.
const CITATION_AUTHOR_CHUNK_PATTERN =
  "[A-Z][A-Za-z'\\u2019`-]*\\.?(?:\\s+(?:[A-Z][A-Za-z'\\u2019`-]*\\.?|van|von|de|del|der|da|di|la|le|du|den|of|the|for|and|&|et\\.?\\s*al\\.?,?))*";
const CITATION_CANDIDATE_REGEX = new RegExp(
  `^(${CITATION_AUTHOR_CHUNK_PATTERN})(\\s*,\\s*|\\s+)(${CITATION_YEAR_PATTERN}(?:\\s*,\\s*${CITATION_YEAR_PATTERN})*)(?:\\s*,\\s*${CITATION_LOCATOR_PATTERN})?$`,
);
const EXPANDED_NARRATIVE_CITATION_REGEX = new RegExp(
  `\\b(${AUTHOR_PHRASE_PATTERN})\\s+\\((${CITATION_YEAR_PATTERN})(?:\\s*,\\s*${CITATION_LOCATOR_PATTERN})?\\)`,
  "g",
);
// Sentence subjects that look like capitalized "authors" but never are.
const NARRATIVE_AUTHOR_STOP_WORDS = new Set([
  "table", "figure", "study", "studies", "experiment", "chapter", "section",
  "appendix", "model", "hypothesis", "wave", "time", "phase", "grade", "item",
  "question", "sample", "session", "step", "trial", "week", "year", "cohort",
]);
const LEAD_IN_BARE_CITATION_REGEX = new RegExp(
  `\\b((?:(?:${CITATION_LEAD_IN_PATTERN})(?:,)?\\s+)+${AUTHOR_PHRASE_PATTERN})\\s*,?\\s*((?:19|20)\\d{2}[a-z]?)(\\s*:\\s*\\d+(?:\\s*[\\u2013\\u2014-]\\s*\\d+)?[A-Za-z]?)?`,
  "g",
);
const PAGE_CITATION_REGEX = /\b(?:p|pp|para)\.?\s*\d+/gi;
// Flags "et. al", "et.al", and bare "et al" while passing the correct "et al."
const MALFORMED_ET_AL_REGEX = /\bet\.\s*al\b\.?|\bet\s+al\b(?!\.)/gi;
const NUMBERED_HEADING_REGEX = /^(\d+(?:\.\d+)*)[.)]?\s+(.+)$/;

function tokenize(text) {
  return text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function slugify(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildReviewLimitations(parsedDocument) {
  if (parsedDocument?.sourceFormat === "pdf") {
    return [
      "Margins, font, line spacing, page numbers, and exact PDF layout are not directly verifiable from extracted PDF text.",
      "Issue locations are best-effort line and entry references derived from extracted text, not native PDF page coordinates.",
      "Heading levels, indentation, and extracted text fidelity should be confirmed manually in the original PDF.",
    ];
  }

  return [
    "Margins, font, line spacing, page numbers, and exact Word layout are not directly verifiable from Mammoth raw-text extraction.",
    "Issue locations are best-effort line and entry references derived from extracted text, not native Word page coordinates.",
    "Hanging indents and exact heading levels should be confirmed in Word even when the text checks pass.",
  ];
}

function normalizeSurname(input) {
  return input.toLowerCase().replace(/[^a-z]/g, "");
}

function sourceNoun(parsedDocument) {
  return parsedDocument.sourceLabel === "PDF" ? "PDF" : "DOCX";
}

function pairKey(author, year) {
  if (!author || !year || /^n\.d\.$/i.test(year)) {
    return null;
  }

  return `${normalizeSurname(author)}-${year.toLowerCase()}`;
}

// "smith-2020a" -> "smith-2020" so year-suffix citations still match their
// reference entry (and vice versa) during cross-checks.
function baseKey(key) {
  return key ? key.replace(/(\d{4})[a-z]$/, "$1") : null;
}

function stripCitationLeadIn(text) {
  return String(text || "")
    .replace(new RegExp(`^(?:(?:${CITATION_LEAD_IN_PATTERN})(?:,)?\\s+)+`, "i"), "")
    .trim();
}

function extractPrimaryAuthorPhrase(text, { reference = false } = {}) {
  let value = stripCitationLeadIn(String(text || ""))
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\bet\.?\s*al\.?/gi, " ")
    .replace(/\bas cited in\b/gi, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!value) {
    return "";
  }

  if (reference) {
    const personalAuthorMatch = value.match(/^(.+?),\s*(?:[A-Z]\.|&|and|$)/);
    if (personalAuthorMatch) {
      value = personalAuthorMatch[1].trim();
    }
  }

  value = value.split(/\s+(?:&|and)\s+/i)[0].trim();

  if (value.includes(",")) {
    value = value.split(",")[0].trim();
  }

  return value.replace(/[;,]+$/g, "").trim();
}

function parseCitationCandidate(rawCandidate) {
  let candidate = String(rawCandidate || "").trim();

  if (!candidate) {
    return null;
  }

  // For secondary sources, APA lists only the source actually consulted in the
  // references, so cross-check against the part after "as cited in".
  const asCitedParts = candidate.split(/\bas cited in\b/i);
  candidate = asCitedParts[asCitedParts.length - 1].trim();

  candidate = stripCitationLeadIn(candidate)
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+/g, " ")
    .trim();

  if (!candidate) {
    return null;
  }

  const match = candidate.match(CITATION_CANDIDATE_REGEX);

  if (!match) {
    return null;
  }

  const author = extractPrimaryAuthorPhrase(match[1]);

  if (!author) {
    return null;
  }

  return {
    author,
    years: match[3].split(/\s*,\s*/).filter(Boolean),
    missingComma: !match[2].includes(","),
  };
}

function truncateExcerpt(text, maxLength = 180) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildLocationLabel({ sectionId, lineStart, lineEnd, paragraphNumber, entryNumber, labelOverride }) {
  if (labelOverride) {
    return labelOverride;
  }

  const sectionLabel = SECTION_LABELS[sectionId] ?? "Document";

  if (entryNumber && lineStart && lineEnd && lineStart !== lineEnd) {
    return `${sectionLabel} entry ${entryNumber} (lines ${lineStart}-${lineEnd})`;
  }

  if (entryNumber && lineStart) {
    return `${sectionLabel} entry ${entryNumber} (line ${lineStart})`;
  }

  if (lineStart && lineEnd && lineStart !== lineEnd) {
    return `${sectionLabel} lines ${lineStart}-${lineEnd}`;
  }

  if (lineStart) {
    return `${sectionLabel} line ${lineStart}`;
  }

  if (paragraphNumber) {
    return `${sectionLabel} paragraph ${paragraphNumber}`;
  }

  return sectionLabel;
}

function makeLocation({
  sectionId,
  lineStart = null,
  lineEnd = null,
  paragraphNumber = null,
  entryNumber = null,
  excerpt = "",
  labelOverride = null,
}) {
  return {
    sectionId,
    lineStart,
    lineEnd,
    paragraphNumber,
    entryNumber,
    label: buildLocationLabel({
      sectionId,
      lineStart,
      lineEnd,
      paragraphNumber,
      entryNumber,
      labelOverride,
    }),
    excerpt: truncateExcerpt(excerpt),
  };
}

function buildLineLocation(sectionId, lineRecord, labelOverride = null) {
  if (!lineRecord) {
    return makeLocation({
      sectionId,
      labelOverride,
    });
  }

  return makeLocation({
    sectionId,
    lineStart: lineRecord.lineNumber,
    lineEnd: lineRecord.lineNumber,
    paragraphNumber: lineRecord.paragraphNumber,
    excerpt: lineRecord.text,
    labelOverride,
  });
}

function buildLineRangeLocation(sectionId, startLineRecord, endLineRecord, excerpt = "", labelOverride = null) {
  if (!startLineRecord && !endLineRecord) {
    return makeLocation({
      sectionId,
      excerpt,
      labelOverride,
    });
  }

  const start = startLineRecord ?? endLineRecord;
  const end = endLineRecord ?? startLineRecord;

  return makeLocation({
    sectionId,
    lineStart: start?.lineNumber ?? null,
    lineEnd: end?.lineNumber ?? null,
    paragraphNumber: start?.paragraphNumber ?? null,
    excerpt: excerpt || start?.text || end?.text || "",
    labelOverride,
  });
}

function buildReferenceLocation(entryRecord) {
  return makeLocation({
    sectionId: "references",
    lineStart: entryRecord?.startLine ?? null,
    lineEnd: entryRecord?.endLine ?? null,
    entryNumber: entryRecord?.entryNumber ?? null,
    excerpt: entryRecord?.text ?? "",
  });
}

function buildSectionLocation(sectionId, lineRecords, fallbackExcerpt = "", labelOverride = null) {
  const startLineRecord = lineRecords?.[0] ?? null;
  const endLineRecord = lineRecords?.[lineRecords.length - 1] ?? null;

  return buildLineRangeLocation(sectionId, startLineRecord, endLineRecord, fallbackExcerpt, labelOverride);
}

function makeFinding(status, title, detail, recommendation, evidence = null, location = null) {
  return {
    id: slugify(`${title}-${detail}-${location?.label ?? ""}`),
    status,
    title,
    detail,
    recommendation,
    evidence,
    location,
  };
}

function makeItemIssue({
  sectionId,
  sectionLabel,
  status,
  title,
  detail,
  recommendation,
  location,
}) {
  return {
    id: slugify(`${sectionId}-${title}-${detail}-${location?.label ?? ""}`),
    source: "rule_based",
    sectionId,
    sectionLabel,
    status,
    title,
    detail,
    recommendation,
    location,
  };
}

function scoreFromFindings(findings) {
  const scored = findings.filter((finding) => finding.status !== "info");

  if (scored.length === 0) {
    return 100;
  }

  const values = {
    pass: 1,
    warning: 0.55,
    fail: 0,
  };

  const total = scored.reduce((sum, finding) => sum + (values[finding.status] ?? 0), 0);
  return Math.round((total / scored.length) * 100);
}

function statusFromFindings(findings) {
  return findings.reduce((highest, finding) => {
    return STATUS_RANK[finding.status] > STATUS_RANK[highest] ? finding.status : highest;
  }, "pass");
}

function buildSection(id, label, summary, findings, metrics = {}) {
  return {
    id,
    label,
    summary,
    findings,
    metrics,
    score: scoreFromFindings(findings),
    status: statusFromFindings(findings),
  };
}

export function extractCitationData(lineRecords) {
  const pairs = [];
  const formattingIssues = [];
  const seenPairSignatures = new Set();
  const seenFormattingIssueSignatures = new Set();

  function pushPair({ author, year, raw, type, lineRecord, matchIndex = 0 }) {
    const key = pairKey(author, year);
    const signature = `${lineRecord.lineNumber}:${matchIndex}:${raw}:${type}:${key}`;

    if (seenPairSignatures.has(signature)) {
      return;
    }

    seenPairSignatures.add(signature);
    pairs.push({
      author,
      year,
      raw,
      type,
      key,
      lineNumber: lineRecord.lineNumber,
      paragraphNumber: lineRecord.paragraphNumber,
      lineText: lineRecord.text,
      location: buildLineLocation("citations", lineRecord),
    });
  }

  function pushFormattingIssue({ lineRecord, raw, detail, recommendation, matchIndex = 0 }) {
    const signature = `${lineRecord.lineNumber}:${matchIndex}:${raw}`;

    if (seenFormattingIssueSignatures.has(signature)) {
      return;
    }

    seenFormattingIssueSignatures.add(signature);
    formattingIssues.push({
      raw,
      detail,
      recommendation,
      location: buildLineLocation("citations", lineRecord),
    });
  }

  for (const lineRecord of lineRecords) {
    const parentheticalMatches = [...lineRecord.text.matchAll(PARENTHETICAL_GROUP_REGEX)];
    const narrativeMatches = [...lineRecord.text.matchAll(EXPANDED_NARRATIVE_CITATION_REGEX)];
    const parentheticalSpans = parentheticalMatches.map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
    // The signal-bare pattern targets non-APA citations in running text
    // ("see Comrie 1976:6-7"); the same shape inside parentheses is valid APA
    // ("(e.g., Smith & Lee, 2020)") and is handled by the parenthetical path.
    const leadInBareMatches = [...lineRecord.text.matchAll(LEAD_IN_BARE_CITATION_REGEX)].filter((match) => {
      const matchStart = match.index ?? 0;
      return !parentheticalSpans.some(([spanStart, spanEnd]) => matchStart >= spanStart && matchStart < spanEnd);
    });

    for (const match of parentheticalMatches) {
      if (!/(?:19|20)\d{2}|n\.d\./i.test(match[1])) {
        continue;
      }

      const groups = match[1]
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);

      for (const group of groups) {
        const parsedCitation = parseCitationCandidate(group);

        if (!parsedCitation) {
          continue;
        }

        for (const year of parsedCitation.years) {
          pushPair({
            author: parsedCitation.author,
            year,
            raw: group,
            type: "parenthetical",
            lineRecord,
            matchIndex: match.index ?? 0,
          });
        }

        if (parsedCitation.missingComma) {
          pushFormattingIssue({
            lineRecord,
            raw: group,
            detail: `The citation "${group}" appears to be missing the comma between author and year.`,
            recommendation: 'Use APA author-date form with a comma, such as "(Smith, 2020)".',
            matchIndex: match.index ?? 0,
          });
        }
      }
    }

    for (const match of narrativeMatches) {
      const author = extractPrimaryAuthorPhrase(match[1]);

      if (!author) {
        continue;
      }

      const leadingWord = match[1].trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      if (NARRATIVE_AUTHOR_STOP_WORDS.has(leadingWord)) {
        continue;
      }

      pushPair({
        author,
        year: match[2],
        raw: match[0],
        type: "narrative",
        lineRecord,
        matchIndex: match.index ?? 0,
      });
    }

    for (const match of leadInBareMatches) {
      const author = extractPrimaryAuthorPhrase(match[1]);

      if (!author) {
        continue;
      }

      pushPair({
        author,
        year: match[2],
        raw: match[0],
        type: "signal_bare",
        lineRecord,
        matchIndex: match.index ?? 0,
      });

      pushFormattingIssue({
        lineRecord,
        raw: match[0],
        detail: match[3]
          ? `The citation "${match[0]}" uses a non-APA author-year format with a colon locator.`
          : `The citation "${match[0]}" uses a non-APA signal-plus-author-year format.`,
        recommendation: match[3]
          ? 'Rewrite it in APA author-date form, such as "see Comrie (1976, pp. 6-7)" when a locator is needed.'
          : 'Rewrite it in APA author-date form, such as "see Comrie (1976)".',
        matchIndex: match.index ?? 0,
      });
    }
  }

  return {
    pairs,
    formattingIssues,
  };
}

function extractReferencePairs(referenceEntryRecords) {
  return referenceEntryRecords.map((entryRecord) => {
    const yearMatch = entryRecord.text.match(/\(((?:19|20)\d{2}[a-z]?)\)|\b((?:19|20)\d{2}[a-z]?)\b/);
    const leadText =
      yearMatch && typeof yearMatch.index === "number" ? entryRecord.text.slice(0, yearMatch.index).trim() : entryRecord.text;
    const author = extractPrimaryAuthorPhrase(leadText, { reference: true });
    const year = yearMatch?.[1] ?? yearMatch?.[2] ?? "";

    return {
      raw: entryRecord.text,
      author,
      year,
      key: pairKey(author, year),
      hasYear: Boolean(year),
      hasRetrievedFrom: /retrieved from/i.test(entryRecord.text),
      hasBareDoi:
        /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i.test(entryRecord.text) &&
        !/https?:\/\/(?:dx\.)?doi\.org\//i.test(entryRecord.text),
      hasLegacyDoiUrl: /https?:\/\/dx\.doi\.org\/|http:\/\/doi\.org\//i.test(entryRecord.text),
      entryNumber: entryRecord.entryNumber,
      startLine: entryRecord.startLine,
      endLine: entryRecord.endLine,
      location: buildReferenceLocation(entryRecord),
    };
  });
}

function buildKeyMatcher(pairs) {
  const exactKeys = new Set(pairs.map((pair) => pair.key).filter(Boolean));
  const baseKeys = new Set(pairs.map((pair) => baseKey(pair.key)).filter(Boolean));

  return (key) => exactKeys.has(key) || baseKeys.has(baseKey(key));
}

function buildCrossChecks(citationPairs, referencePairs) {
  const citationKeys = unique(citationPairs.map((pair) => pair.key));
  const referenceKeys = unique(referencePairs.map((pair) => pair.key));
  const matchesReference = buildKeyMatcher(referencePairs);
  const matchesCitation = buildKeyMatcher(citationPairs);

  return {
    unmatchedCitations: citationKeys.filter((key) => !matchesReference(key)),
    uncitedReferences: referenceKeys.filter((key) => !matchesCitation(key)),
  };
}

function parseYearForOrdering(year) {
  const match = String(year || "").match(/^(\d{4})([a-z]?)$/i);

  if (!match) {
    return null;
  }

  return {
    value: Number.parseInt(match[1], 10),
    suffix: match[2].toLowerCase(),
  };
}

// Single source of truth for reference-list ordering: the section finding and
// the per-entry issues both derive from this result, so they cannot disagree.
// Same-surname entries follow APA's year-ascending tie-break.
export function computeReferenceOrdering(referencePairs) {
  const orderedPairs = referencePairs.filter((pair) => Boolean(pair.author));
  const issues = [];

  for (let index = 1; index < orderedPairs.length; index += 1) {
    const previous = orderedPairs[index - 1];
    const current = orderedPairs[index];
    const surnameComparison = normalizeSurname(previous.author).localeCompare(normalizeSurname(current.author), "en", {
      sensitivity: "base",
    });

    if (surnameComparison > 0) {
      issues.push({ previous, current, reason: "surname" });
      continue;
    }

    if (surnameComparison === 0) {
      const previousYear = parseYearForOrdering(previous.year);
      const currentYear = parseYearForOrdering(current.year);

      if (!previousYear || !currentYear) {
        continue;
      }

      if (
        previousYear.value > currentYear.value ||
        (previousYear.value === currentYear.value && previousYear.suffix > currentYear.suffix)
      ) {
        issues.push({ previous, current, reason: "year" });
      }
    }
  }

  return {
    isSorted: issues.length === 0,
    issues,
  };
}

function detectNumberedHeadings(lineRecords) {
  return lineRecords
    .map((lineRecord) => {
      const match = lineRecord.text.match(NUMBERED_HEADING_REGEX);
      if (!match) {
        return null;
      }

      const headingText = match[2].trim();
      const wordCount = tokenize(headingText).length;

      // Reject lines that merely start with a digit ("5 participants were
      // excluded...") or numbered list items: real headings are short, start
      // like a title, and do not end in sentence punctuation.
      if (wordCount === 0 || wordCount > 12) {
        return null;
      }

      if (!/^[A-Z0-9]/.test(headingText) || /[.!?:;,]$/.test(headingText)) {
        return null;
      }

      return {
        sequence: match[1],
        parts: match[1].split(".").map((part) => Number.parseInt(part, 10)),
        headingText,
        lineRecord,
      };
    })
    .filter(Boolean);
}

function findHeadingNumberingIssues(lineRecords) {
  const numberedHeadings = detectNumberedHeadings(lineRecords).filter((heading) => heading.parts.length === 1);

  // A single numbered line is far more likely stray text than a numbering
  // scheme; only check continuity when numbering is clearly in use.
  if (numberedHeadings.length < 2) {
    return [];
  }

  const issues = [];

  for (let index = 0; index < numberedHeadings.length; index += 1) {
    const current = numberedHeadings[index];
    const previous = numberedHeadings[index - 1] ?? null;

    if (!previous && current.parts[0] !== 1) {
      issues.push({
        type: "starts_above_one",
        current,
        expected: 1,
      });
      continue;
    }

    if (!previous) {
      continue;
    }

    const expected = previous.parts[0] + 1;

    if (current.parts[0] > expected) {
      issues.push({
        type: "missing_number",
        current,
        previous,
        expected,
      });
    } else if (current.parts[0] <= previous.parts[0]) {
      issues.push({
        type: "out_of_order",
        current,
        previous,
        expected,
      });
    }
  }

  return issues;
}

function findMalformedEtAlOccurrences(lineRecords) {
  const issues = [];

  for (const lineRecord of lineRecords) {
    const matches = [...lineRecord.text.matchAll(MALFORMED_ET_AL_REGEX)];

    for (const match of matches) {
      issues.push({
        raw: match[0],
        lineRecord,
      });
    }
  }

  return issues;
}

const QUOTED_SPAN_REGEX = /["\u201c]([^"\u201c\u201d]+)["\u201d]/g;
const MIN_QUOTED_SPAN_WORDS = 8;

function findQuotedSegmentsWithoutLocator(segmentRecords) {
  return segmentRecords.filter((segmentRecord) => {
    if (segmentRecord.zone !== "main") {
      return false;
    }

    // Only properly paired quote spans long enough to be actual quotations
    // need a locator; scare quotes and quoted titles should not trigger this.
    const quotedSpans = [...segmentRecord.text.matchAll(QUOTED_SPAN_REGEX)];
    const hasSubstantialQuote = quotedSpans.some((span) => tokenize(span[1]).length >= MIN_QUOTED_SPAN_WORDS);

    if (!hasSubstantialQuote) {
      return false;
    }

    return !/\b(?:p|pp|para)\.?\s*\d+/i.test(segmentRecord.text);
  });
}

function worstStatus(...statuses) {
  return statuses.reduce((highest, status) => {
    return STATUS_RANK[status] > STATUS_RANK[highest] ? status : highest;
  }, "pass");
}

function buildHeadline(status, failCount, warningCount) {
  if (status === "fail") {
    return `The draft has ${failCount} high-priority APA issue${failCount === 1 ? "" : "s"} and ${warningCount} warning${warningCount === 1 ? "" : "s"}.`;
  }

  if (status === "warning") {
    return `The draft is close, but ${warningCount} APA item${warningCount === 1 ? "" : "s"} still need review.`;
  }

  return "No obvious APA 7 issues were detected in the parsed excerpts.";
}

export function extractReferenceData(parsedDocument) {
  return {
    referencePairs: extractReferencePairs(parsedDocument.referenceEntryRecords),
  };
}

function buildDocumentContentLocation(parsedDocument) {
  return buildSectionLocation("document", parsedDocument.mainLineRecords, parsedDocument.preReferencesText);
}

function buildDocumentEndLocation(parsedDocument) {
  return buildLineLocation(
    "document",
    parsedDocument.mainLineRecords[parsedDocument.mainLineRecords.length - 1] ?? null,
    parsedDocument.mainLineRecords.length > 0
      ? `After line ${parsedDocument.mainLineRecords[parsedDocument.mainLineRecords.length - 1].lineNumber}`
      : "Document start",
  );
}

function buildBodyLocation(parsedDocument) {
  return buildSectionLocation("body", parsedDocument.bodyLineRecords, parsedDocument.bodyText);
}

function buildReferencesSectionLocation(parsedDocument) {
  return buildSectionLocation(
    "references",
    parsedDocument.referenceLineRecords,
    parsedDocument.referencesText,
    parsedDocument.referencesHeadingLineNumber
      ? `References section starting at line ${parsedDocument.referencesHeadingLineNumber}`
      : "References section location unavailable",
  );
}

export function analyzeDocumentStructure(parsedDocument) {
  const documentContentLocation = buildDocumentContentLocation(parsedDocument);
  const documentEndLocation = buildDocumentEndLocation(parsedDocument);
  const referencesHeadingLabel = parsedDocument.referencesHeadingLabel ?? null;
  const hasNonApaReferencesLabel = Boolean(
    referencesHeadingLabel && referencesHeadingLabel.trim().toLowerCase() !== "references",
  );
  const noun = sourceNoun(parsedDocument);
  const referencesHeadingLocation = parsedDocument.referencesHeadingLineNumber
    ? makeLocation({
        sectionId: "document",
        lineStart: parsedDocument.referencesHeadingLineNumber,
        lineEnd: parsedDocument.referencesHeadingLineNumber,
        excerpt: referencesHeadingLabel ?? "References",
        labelOverride: `References heading at line ${parsedDocument.referencesHeadingLineNumber}`,
      })
    : null;
  const itemIssues = [];

  if (hasNonApaReferencesLabel) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "document",
        sectionLabel: "Document Structure",
        status: "warning",
        title: "Non-APA reference-list label",
        detail: `The reference list is labeled "${referencesHeadingLabel}", but APA 7 uses the heading "References".`,
        recommendation: 'Rename the reference-list heading to "References".',
        location: referencesHeadingLocation,
      }),
    );
  }

  if (parsedDocument.parserMessages.length > 0) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "document",
        sectionLabel: "Document Structure",
        status: "warning",
        title: `${noun} extraction warning`,
        detail: `The ${noun} parser returned warnings that may affect downstream APA checks.`,
        recommendation: `Inspect the ${noun} for unsupported elements such as text boxes or embedded objects.`,
        location: documentContentLocation,
      }),
    );
  }

  if (parsedDocument.wordCount < 500) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "document",
        sectionLabel: "Document Structure",
        status: "warning",
        title: "Limited extracted text",
        detail: `Only ${parsedDocument.wordCount} words were extracted, so some APA checks may be inconclusive.`,
        recommendation: `Confirm that the ${noun} contains selectable text rather than scanned content.`,
        location: documentContentLocation,
      }),
    );
  }

  if (parsedDocument.referencesMissing) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "document",
        sectionLabel: "Document Structure",
        status: "fail",
        title: "References heading missing",
        detail: 'A standalone "References" heading was not detected in the parsed text.',
        recommendation: `Add a "References" heading and ensure it appears as plain body text in the ${noun}.`,
        location: documentEndLocation,
      }),
    );
  }

  const section = buildSection(
    "document",
    "Document Structure",
    "Checks whether the parser extracted enough structured text to run the APA review reliably.",
    [
      parsedDocument.parserMessages.length === 0
        ? makeFinding("pass", `${noun} extraction`, `The ${noun} parsed cleanly.`, "No parser remediation needed.")
        : makeFinding(
            "warning",
            `${noun} extraction`,
            `The ${noun} parser returned warnings that may affect some downstream checks.`,
            `Inspect the source ${noun} for unusual elements such as text boxes or embedded objects.`,
            parsedDocument.parserMessages.map((message) => message.message).join(" | "),
            documentContentLocation,
          ),
      parsedDocument.wordCount >= 500
        ? makeFinding(
            "pass",
            "Sufficient text extracted",
            `The parser captured ${parsedDocument.wordCount} words, which is enough for a useful APA pass.`,
            "Proceed with the hybrid review.",
          )
        : makeFinding(
            "warning",
            "Limited extracted text",
            `Only ${parsedDocument.wordCount} words were extracted, so some APA checks may be inconclusive.`,
            `Confirm that the ${noun} contains selectable text rather than scanned content.`,
            null,
            documentContentLocation,
          ),
      parsedDocument.referencesMissing
        ? makeFinding(
            "fail",
            "References heading missing",
            'A standalone "References" heading was not detected in the parsed text.',
            `Add a "References" heading and ensure it appears as plain body text in the ${noun}.`,
            null,
            documentEndLocation,
          )
        : hasNonApaReferencesLabel
          ? makeFinding(
              "warning",
              "Non-APA reference-list label",
              `The reference list is labeled "${referencesHeadingLabel}", but APA 7 uses the heading "References".`,
              'Rename the reference-list heading to "References".',
              null,
              referencesHeadingLocation,
            )
          : makeFinding(
              "pass",
              "References heading detected",
              "A references section was identified in the parsed document.",
              "Keep the heading on its own line so it remains detectable.",
              null,
              referencesHeadingLocation,
            ),
    ],
    {
      wordCount: parsedDocument.wordCount,
      parserMessageCount: parsedDocument.parserMessages.length,
      referenceEntryCount: parsedDocument.metrics.referenceEntryCount,
    },
  );

  return { section, itemIssues };
}

export function analyzeTitlePage(parsedDocument) {
  const titlePageLocation = buildSectionLocation("titlePage", parsedDocument.titlePageLineRecords, parsedDocument.titlePageText);
  const noun = sourceNoun(parsedDocument);
  const matchedTitlePageCues = TITLE_PAGE_CUES.filter((cue) => cue.regex.test(parsedDocument.titlePageText));
  const missingTitlePageCues = TITLE_PAGE_CUES.filter((cue) => !cue.regex.test(parsedDocument.titlePageText));
  const hasEnoughTitlePageCues = matchedTitlePageCues.length >= 2;
  const itemIssues = [];

  if (parsedDocument.metrics.titlePageWords < 40) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "titlePage",
        sectionLabel: "Title Page",
        status: "warning",
        title: "Sparse title-page text",
        detail: `Only ${parsedDocument.metrics.titlePageWords} title-page words were extracted.`,
        recommendation: `Confirm that the title page content is present as editable text in the ${noun}.`,
        location: titlePageLocation,
      }),
    );
  }

  if (!/\b(university|college|department|school|faculty|program|thesis|dissertation|submitted)\b/i.test(parsedDocument.titlePageText)) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "titlePage",
        sectionLabel: "Title Page",
        status: "warning",
        title: "Institutional metadata unclear",
        detail: "The title-page excerpt does not clearly show affiliation or thesis-submission wording.",
        recommendation: "Review the title page for author, affiliation, and thesis metadata placement.",
        location: titlePageLocation,
      }),
    );
  }

  if (!hasEnoughTitlePageCues) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "titlePage",
        sectionLabel: "Title Page",
        status: "warning",
        title: "Student title-page elements incomplete",
        detail: `The title-page excerpt shows few APA 7 student title-page elements. Not detected: ${missingTitlePageCues
          .map((cue) => cue.label)
          .join(", ")}.`,
        recommendation:
          "An APA 7 student title page lists the title, author, affiliation, course, instructor, and due date on separate lines.",
        location: titlePageLocation,
      }),
    );
  }

  const section = buildSection(
    "titlePage",
    "Title Page",
    "Heuristic checks on the first extracted title-page excerpt.",
    [
      parsedDocument.metrics.titlePageWords >= 40
        ? makeFinding(
            "pass",
            "Title-page excerpt captured",
            `The first title-page excerpt contains ${parsedDocument.metrics.titlePageWords} words.`,
            "No action required unless the title page is intentionally very short.",
          )
        : makeFinding(
            "warning",
            "Sparse title-page text",
            `Only ${parsedDocument.metrics.titlePageWords} title-page words were extracted.`,
            `Confirm that the title page content is present as editable text in the ${noun}.`,
            null,
            titlePageLocation,
          ),
      /\b(university|college|department|school|faculty|program|thesis|dissertation|submitted)\b/i.test(parsedDocument.titlePageText)
        ? makeFinding(
            "pass",
            "Institutional metadata present",
            "The title-page excerpt includes thesis or institutional wording.",
            "Verify the exact APA placement manually before submission.",
          )
        : makeFinding(
            "warning",
            "Institutional metadata unclear",
            "The title-page excerpt does not clearly show affiliation or thesis-submission wording.",
            "Review the title page for author, affiliation, and thesis metadata placement.",
            null,
            titlePageLocation,
          ),
      hasEnoughTitlePageCues
        ? makeFinding(
            "pass",
            "Student title-page elements detected",
            `The title-page excerpt shows APA 7 student title-page elements: ${matchedTitlePageCues
              .map((cue) => cue.label)
              .join(", ")}.`,
            "Confirm the exact ordering (title, author, affiliation, course, instructor, due date) in the source document.",
          )
        : makeFinding(
            "warning",
            "Student title-page elements incomplete",
            `The title-page excerpt shows few APA 7 student title-page elements. Not detected: ${missingTitlePageCues
              .map((cue) => cue.label)
              .join(", ")}.`,
            "An APA 7 student title page lists the title, author, affiliation, course, instructor, and due date on separate lines.",
            null,
            titlePageLocation,
          ),
    ],
    {
      excerptWordCount: parsedDocument.metrics.titlePageWords,
    },
  );

  return { section, itemIssues };
}

export function analyzeBody(parsedDocument) {
  const noun = sourceNoun(parsedDocument);
  const bodyLocation = buildBodyLocation(parsedDocument);
  const headingMatches = HEADING_PATTERNS.filter((item) => item.regex.test(parsedDocument.normalizedText)).map(
    (item) => item.label,
  );
  const numberedHeadingIssues = findHeadingNumberingIssues(parsedDocument.mainLineRecords);
  const itemIssues = [];

  if (parsedDocument.metrics.bodyWords < 300) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "body",
        sectionLabel: "Body and Headings",
        status: "warning",
        title: "Short body excerpt",
        detail: `Only ${parsedDocument.metrics.bodyWords} body words were captured for review.`,
        recommendation: `Verify that body text starts after the title page and remains selectable in the ${noun}.`,
        location: bodyLocation,
      }),
    );
  }

  if (headingMatches.length < 2) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "body",
        sectionLabel: "Body and Headings",
        status: "warning",
        title: "Few APA-style headings detected",
        detail: "The parser found limited evidence of APA-style section headings in the excerpt.",
        recommendation: "Review heading levels, especially for major thesis sections.",
        location: bodyLocation,
      }),
    );
  }

  if (parsedDocument.segments.length < 6) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "body",
        sectionLabel: "Body and Headings",
        status: "warning",
        title: "Limited paragraph structure",
        detail: `The parsed ${noun} has relatively few paragraph breaks, which can hide heading and spacing issues.`,
        recommendation: "Check paragraph breaks and body structure in the source document.",
        location: bodyLocation,
      }),
    );
  }

  for (const numberingIssue of numberedHeadingIssues) {
    const currentLocation = buildLineLocation("body", numberingIssue.current.lineRecord);
    const title =
      numberingIssue.type === "missing_number" ? "Missing section number in sequence" : "Section numbering out of sequence";
    const detail =
      numberingIssue.type === "missing_number"
        ? `Heading numbering jumps to ${numberingIssue.current.parts[0]} without a visible section ${numberingIssue.expected}.`
        : numberingIssue.type === "starts_above_one"
          ? `The first numbered heading starts at ${numberingIssue.current.parts[0]} instead of 1.`
          : `Heading numbering resumes at ${numberingIssue.current.parts[0]} after ${numberingIssue.previous.parts[0]}.`;

    itemIssues.push(
      makeItemIssue({
        sectionId: "body",
        sectionLabel: "Body and Headings",
        status: "warning",
        title,
        detail,
        recommendation: "Review chapter or section numbering for missing, duplicated, or out-of-order values.",
        location: currentLocation,
      }),
    );
  }

  const section = buildSection(
    "body",
    "Body and Headings",
    "Looks for enough body text, common APA section headings, and section-numbering continuity when numbered headings are used.",
    [
      parsedDocument.metrics.bodyWords >= 300
        ? makeFinding(
            "pass",
            "Body excerpt captured",
            `The extracted body excerpt contains ${parsedDocument.metrics.bodyWords} words.`,
            "No action required.",
          )
        : makeFinding(
            "warning",
            "Short body excerpt",
            `Only ${parsedDocument.metrics.bodyWords} body words were captured for review.`,
            `Verify that body text starts after the title page and remains selectable in the ${noun}.`,
            null,
            bodyLocation,
          ),
      headingMatches.length >= 2
        ? makeFinding(
            "pass",
            "Section headings detected",
            `Detected heading cues: ${headingMatches.join(", ")}.`,
            "Keep heading levels consistent throughout the thesis.",
          )
        : makeFinding(
            "warning",
            "Few APA-style headings detected",
            "The parser found limited evidence of APA-style section headings in the excerpt.",
            "Review heading levels, especially for major thesis sections.",
            null,
            bodyLocation,
          ),
      numberedHeadingIssues.length === 0
        ? makeFinding(
            "pass",
            "Numbered headings stay in sequence",
            "No obvious numbering gaps were detected among numbered top-level headings.",
            "No action required.",
          )
        : makeFinding(
            "warning",
            "Numbered heading sequence issue",
            `Detected ${numberedHeadingIssues.length} numbered heading sequence issue${numberedHeadingIssues.length === 1 ? "" : "s"}.`,
            "Review chapter or section numbering for missing, duplicated, or out-of-order values.",
            null,
            buildLineLocation("body", numberedHeadingIssues[0].current.lineRecord),
          ),
      parsedDocument.segments.length >= 6
        ? makeFinding(
            "pass",
            "Multi-paragraph structure detected",
            `The document contains ${parsedDocument.segments.length} text segments.`,
            "No action required.",
          )
        : makeFinding(
            "warning",
            "Limited paragraph structure",
            `The parsed ${noun} has relatively few paragraph breaks, which can hide heading and spacing issues.`,
            "Check paragraph breaks and body structure in the source document.",
            null,
            bodyLocation,
          ),
    ],
    {
      bodyWordCount: parsedDocument.metrics.bodyWords,
      headingCount: headingMatches.length,
      segmentCount: parsedDocument.segments.length,
      numberedHeadingIssueCount: numberedHeadingIssues.length,
    },
  );

  return { section, itemIssues };
}

export function analyzeCitations(parsedDocument, citationData, referenceData) {
  const { pairs: citationPairs, formattingIssues: nonApaCitationFormattingIssues } = citationData;
  const { referencePairs } = referenceData;
  const bodyLocation = buildBodyLocation(parsedDocument);
  const malformedEtAlIssues = findMalformedEtAlOccurrences(parsedDocument.bodyLineRecords);
  const quoteLocatorIssues = findQuotedSegmentsWithoutLocator(parsedDocument.segmentRecords);
  const pageCitationCount = [...parsedDocument.bodyText.matchAll(PAGE_CITATION_REGEX)].length;
  const matchesReference = buildKeyMatcher(referencePairs);
  const unmatchedCitationsByKey = new Map();

  for (const citationPair of citationPairs) {
    if (!citationPair.key || matchesReference(citationPair.key)) {
      continue;
    }

    const existingGroup = unmatchedCitationsByKey.get(citationPair.key);

    if (existingGroup) {
      existingGroup.occurrenceCount += 1;
    } else {
      unmatchedCitationsByKey.set(citationPair.key, { pair: citationPair, occurrenceCount: 1 });
    }
  }

  const unmatchedCitationGroups = [...unmatchedCitationsByKey.values()];
  const itemIssues = [];

  if (citationPairs.length === 0 && parsedDocument.metrics.bodyWords >= 600) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "citations",
        sectionLabel: "Citations",
        status: "fail",
        title: "No in-text citations detected",
        detail: "No APA-style in-text citations were detected in the body excerpt.",
        recommendation: "Review the body for parenthetical or narrative citations.",
        location: bodyLocation,
      }),
    );
  }

  for (const malformedEtAlIssue of malformedEtAlIssues) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "citations",
        sectionLabel: "Citations",
        status: "fail",
        title: "Malformed et al. citation",
        detail: `Detected likely malformed "${malformedEtAlIssue.raw}" usage.`,
        recommendation: 'Use "et al." with a trailing period in APA 7.',
        location: buildLineLocation("citations", malformedEtAlIssue.lineRecord),
      }),
    );
  }

  for (const nonApaCitationFormattingIssue of nonApaCitationFormattingIssues) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "citations",
        sectionLabel: "Citations",
        status: "fail",
        title: "Non-APA citation format",
        detail: nonApaCitationFormattingIssue.detail,
        recommendation: nonApaCitationFormattingIssue.recommendation,
        location: nonApaCitationFormattingIssue.location,
      }),
    );
  }

  for (const quoteLocatorIssue of quoteLocatorIssues) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "citations",
        sectionLabel: "Citations",
        status: "warning",
        title: "Quoted text may lack locator citation",
        detail: "Quoted text was detected in this paragraph, but no page or paragraph locator was found.",
        recommendation: "Check direct quotations for APA page or paragraph citations.",
        location: makeLocation({
          sectionId: "citations",
          lineStart: quoteLocatorIssue.lineStart,
          lineEnd: quoteLocatorIssue.lineEnd,
          paragraphNumber: quoteLocatorIssue.paragraphNumber,
          excerpt: quoteLocatorIssue.text,
        }),
      }),
    );
  }

  for (const unmatchedGroup of unmatchedCitationGroups) {
    const occurrenceNote =
      unmatchedGroup.occurrenceCount > 1 ? ` It appears ${unmatchedGroup.occurrenceCount} times in the excerpt.` : "";

    itemIssues.push(
      makeItemIssue({
        sectionId: "citations",
        sectionLabel: "Citations",
        status: "fail",
        title: "In-text citation missing from references",
        detail: `The citation "${unmatchedGroup.pair.raw}" could not be matched to a reference entry.${occurrenceNote}`,
        recommendation: "Add the corresponding reference entry or correct the author-year formatting mismatch.",
        location: unmatchedGroup.pair.location,
      }),
    );
  }

  const section = buildSection(
    "citations",
    "Citations",
    "Checks citation density, common APA citation syntax, and citation/reference crosswalks.",
    [
      citationPairs.length > 0
        ? makeFinding(
            "pass",
            "In-text citations detected",
            `Detected ${citationPairs.length} citation instance${citationPairs.length === 1 ? "" : "s"} in the body excerpt.`,
            "Confirm punctuation and italicization manually where needed.",
          )
        : makeFinding(
            parsedDocument.metrics.bodyWords >= 600 ? "fail" : "warning",
            "No in-text citations detected",
            "No APA-style in-text citations were detected in the body excerpt.",
            "Review the body for parenthetical or narrative citations.",
            null,
            bodyLocation,
          ),
      malformedEtAlIssues.length === 0
        ? makeFinding("pass", "No obvious et al. errors", 'No malformed "et al." patterns were detected.', "No action required.")
        : makeFinding(
            "fail",
            "Malformed et al. citations found",
            `Detected ${malformedEtAlIssues.length} likely malformed "et al." citation${malformedEtAlIssues.length === 1 ? "" : "s"}.`,
            'Use "et al." with a trailing period in APA 7.',
            null,
            buildLineLocation("citations", malformedEtAlIssues[0].lineRecord),
          ),
      quoteLocatorIssues.length === 0
        ? makeFinding(
            "pass",
            "Locator citations not obviously missing",
            "No obvious mismatch between quotations and page-style locators was detected.",
            "No action required.",
          )
        : makeFinding(
            "warning",
            "Quoted text may lack locator citations",
            `Detected ${quoteLocatorIssues.length} quoted paragraph${quoteLocatorIssues.length === 1 ? "" : "s"} without a page or paragraph locator.`,
            "Check direct quotations for APA page or paragraph citations.",
            null,
            makeLocation({
              sectionId: "citations",
              lineStart: quoteLocatorIssues[0].lineStart,
              lineEnd: quoteLocatorIssues[0].lineEnd,
              paragraphNumber: quoteLocatorIssues[0].paragraphNumber,
              excerpt: quoteLocatorIssues[0].text,
            }),
          ),
      unmatchedCitationGroups.length === 0
        ? makeFinding(
            "pass",
            "Citations matched to references",
            "Every detectable citation pair in the excerpt was found in the extracted references.",
            "No action required.",
          )
        : makeFinding(
            unmatchedCitationGroups.length >= 3 ? "fail" : "warning",
            "Citations missing from references",
            `${unmatchedCitationGroups.length} cited source${unmatchedCitationGroups.length === 1 ? "" : "s"} could not be matched to the references list.`,
            "Check author-year consistency between in-text citations and the References section.",
            null,
            unmatchedCitationGroups[0].pair.location,
          ),
    ],
    {
      citationCount: citationPairs.length,
      pageCitationCount,
      unmatchedCitationCount: unmatchedCitationGroups.length,
      malformedEtAlCount: malformedEtAlIssues.length,
    },
  );

  return { section, itemIssues };
}

export function analyzeReferences(parsedDocument, citationData, referenceData) {
  const { pairs: citationPairs } = citationData;
  const { referencePairs } = referenceData;
  const noun = sourceNoun(parsedDocument);
  const referencesLocation = buildReferencesSectionLocation(parsedDocument);
  const referenceOrdering = computeReferenceOrdering(referencePairs);
  const matchesCitation = buildKeyMatcher(citationPairs);
  const uncitedReferencePairs = referencePairs.filter((referencePair) => referencePair.key && !matchesCitation(referencePair.key));
  const missingYearReferences = referencePairs.filter((referencePair) => !referencePair.hasYear);
  const referenceFormattingIssues = referencePairs.filter(
    (referencePair) => referencePair.hasBareDoi || referencePair.hasRetrievedFrom,
  );
  const legacyDoiReferences = referencePairs.filter((referencePair) => referencePair.hasLegacyDoiUrl);
  const itemIssues = [];

  for (const legacyDoiReference of legacyDoiReferences) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "references",
        sectionLabel: "References",
        status: "info",
        title: "Legacy DOI URL format",
        detail: "This reference uses the older dx.doi.org (or http://doi.org) DOI URL style.",
        recommendation: "Update the DOI link to the current https://doi.org/ format.",
        location: legacyDoiReference.location,
      }),
    );
  }

  if (parsedDocument.referencesMissing) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "references",
        sectionLabel: "References",
        status: "fail",
        title: "Reference list not extracted",
        detail: 'The parser could not extract entries after a "References" heading.',
        recommendation: `Ensure the references heading is plain body text and that entries remain in editable ${noun} text.`,
        location: referencesLocation,
      }),
    );
  }

  if (!parsedDocument.referencesMissing && referencePairs.length < 3) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "references",
        sectionLabel: "References",
        status: "warning",
        title: "Low reference count",
        detail: `Only ${referencePairs.length} reference entr${referencePairs.length === 1 ? "y" : "ies"} were detected.`,
        recommendation: `Check the references heading and paragraph breaks in the ${noun}.`,
        location: referencesLocation,
      }),
    );
  }

  for (const missingYearReference of missingYearReferences) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "references",
        sectionLabel: "References",
        status: "warning",
        title: "Reference entry missing year",
        detail: "This reference entry does not clearly contain a publication year.",
        recommendation: "Check author-date formatting in the References section.",
        location: missingYearReference.location,
      }),
    );
  }

  for (const orderingIssue of referenceOrdering.issues) {
    const isYearIssue = orderingIssue.reason === "year";

    itemIssues.push(
      makeItemIssue({
        sectionId: "references",
        sectionLabel: "References",
        status: "warning",
        title: isYearIssue ? "Same-author references out of year order" : "Reference entry out of alphabetical order",
        detail: isYearIssue
          ? `The entry "${orderingIssue.current.raw}" shares its first author with the previous entry but has an earlier year.`
          : `The entry "${orderingIssue.current.raw}" appears after "${orderingIssue.previous.raw}" but sorts earlier alphabetically.`,
        recommendation: isYearIssue
          ? "Order works by the same first author from earliest to latest year."
          : "Sort the References section alphabetically by the first author surname.",
        location: orderingIssue.current.location,
      }),
    );
  }

  for (const referenceFormattingIssue of referenceFormattingIssues) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "references",
        sectionLabel: "References",
        status: "warning",
        title: referenceFormattingIssue.hasBareDoi ? "Reference entry contains bare DOI" : "Reference entry uses outdated retrieval phrasing",
        detail: referenceFormattingIssue.hasBareDoi
          ? "This reference contains a DOI that is not formatted as a https://doi.org/ URL."
          : 'This reference uses older "Retrieved from" phrasing that may not be needed in APA 7.',
        recommendation: referenceFormattingIssue.hasBareDoi
          ? "Convert the DOI to https://doi.org/ format."
          : "Remove outdated retrieval phrasing unless the source type specifically requires it.",
        location: referenceFormattingIssue.location,
      }),
    );
  }

  for (const uncitedReferencePair of uncitedReferencePairs) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "references",
        sectionLabel: "References",
        status: "warning",
        title: "Reference entry may be uncited",
        detail: "This reference entry was not matched to any in-text citation in the extracted body excerpt.",
        recommendation: "Either cite this source in the body or remove it from the References section if it is unused.",
        location: uncitedReferencePair.location,
      }),
    );
  }

  const section = buildSection(
    "references",
    "References",
    "Checks reference list presence, rough entry structure, ordering, and citation crosswalks.",
    [
      parsedDocument.referencesMissing
        ? makeFinding(
            "fail",
            "Reference list not extracted",
            'The parser could not extract entries after a "References" heading.',
            `Ensure the references heading is plain body text and that entries remain in editable ${noun} text.`,
            null,
            referencesLocation,
          )
        : makeFinding(
            "pass",
            "Reference list extracted",
            `Detected ${parsedDocument.metrics.referenceEntryCount} reference entr${
              parsedDocument.metrics.referenceEntryCount === 1 ? "y" : "ies"
            }.`,
            "No action required.",
          ),
      referencePairs.length >= 3
        ? makeFinding(
            "pass",
            "Reference count looks plausible",
            `The extracted references section contains ${referencePairs.length} entries.`,
            "No action required.",
          )
        : makeFinding(
            parsedDocument.referencesMissing ? "fail" : "warning",
            "Low reference count",
            `Only ${referencePairs.length} reference entr${referencePairs.length === 1 ? "y" : "ies"} were detected.`,
            `Check the references heading and paragraph breaks in the ${noun}.`,
            null,
            referencesLocation,
          ),
      missingYearReferences.length === 0
        ? makeFinding(
            "pass",
            "Publication years detected",
            "Each extracted reference entry appears to contain a publication year.",
            "No action required.",
          )
        : makeFinding(
            "warning",
            "Missing years in references",
            `${missingYearReferences.length} reference entr${missingYearReferences.length === 1 ? "y appears" : "ies appear"} to be missing a publication year.`,
            "Check author-date formatting in the References section.",
            null,
            missingYearReferences[0].location,
          ),
      referenceOrdering.isSorted
        ? makeFinding(
            "pass",
            "Alphabetical ordering looks correct",
            "The reference entries appear alphabetized by first author surname.",
            "No action required.",
          )
        : makeFinding(
            "warning",
            "Alphabetical ordering may be incorrect",
            `Detected ${referenceOrdering.issues.length} reference entr${referenceOrdering.issues.length === 1 ? "y" : "ies"} out of order.`,
            "Sort references alphabetically by first author surname, with same-author works ordered by year.",
            null,
            referenceOrdering.issues[0]?.current?.location ?? referencesLocation,
          ),
      referenceFormattingIssues.length === 0 && uncitedReferencePairs.length === 0
        ? makeFinding(
            "pass",
            "No obvious reference formatting or crosswalk issues",
            "The extracted reference entries do not show common DOI URL problems or uncited entries.",
            "No action required.",
          )
        : makeFinding(
            "warning",
            "Reference formatting or crosswalk review needed",
            `${referenceFormattingIssues.length} formatting issue${referenceFormattingIssues.length === 1 ? "" : "s"} and ${uncitedReferencePairs.length} potentially uncited reference entr${uncitedReferencePairs.length === 1 ? "y" : "ies"} were detected.`,
            "Normalize DOI/retrieval formatting and confirm that each reference is cited in the body.",
            null,
            referenceFormattingIssues[0]?.location ?? uncitedReferencePairs[0]?.location ?? referencesLocation,
          ),
    ],
    {
      entryCount: referencePairs.length,
      missingYearCount: missingYearReferences.length,
      uncitedReferenceCount: uncitedReferencePairs.length,
      referenceFormattingIssueCount: referenceFormattingIssues.length,
    },
  );

  return { section, itemIssues };
}

export function assembleRuleBasedReport({ parsedDocument, citationData, referenceData, parts }) {
  const crossChecks = buildCrossChecks(citationData.pairs, referenceData.referencePairs);
  const sections = parts.map((part) => part.section);
  const orderedSections = SECTION_ORDER.map((sectionId) => sections.find((section) => section.id === sectionId)).filter(Boolean);
  const itemIssues = parts.flatMap((part) => part.itemIssues);
  const allFindings = orderedSections.flatMap((section) => section.findings);
  const passCount = allFindings.filter((finding) => finding.status === "pass").length;
  const warningCount = allFindings.filter((finding) => finding.status === "warning").length;
  const failCount = allFindings.filter((finding) => finding.status === "fail").length;
  const overallStatus = orderedSections.reduce((status, section) => worstStatus(status, section.status), "pass");
  const overallScore = Math.max(0, 100 - failCount * 15 - warningCount * 6);
  const bodyMetrics = orderedSections.find((section) => section.id === "body")?.metrics ?? {};

  return {
    summary: {
      overallStatus,
      score: overallScore,
      passCount,
      warningCount,
      failCount,
      headline: buildHeadline(overallStatus, failCount, warningCount),
    },
    sections: orderedSections,
    itemIssues,
    crossChecks,
    metrics: {
      citationCount: citationData.pairs.length,
      referenceCount: referenceData.referencePairs.length,
      headingCount: bodyMetrics.headingCount ?? 0,
      numberedHeadingIssueCount: bodyMetrics.numberedHeadingIssueCount ?? 0,
      itemIssueCount: itemIssues.length,
    },
    limitations: buildReviewLimitations(parsedDocument),
  };
}

export function runRuleBasedReview(parsedDocument) {
  const citationData = extractCitationData(parsedDocument.bodyLineRecords);
  const referenceData = extractReferenceData(parsedDocument);
  const parts = [
    analyzeDocumentStructure(parsedDocument),
    analyzeTitlePage(parsedDocument),
    analyzeBody(parsedDocument),
    analyzeCitations(parsedDocument, citationData, referenceData),
    analyzeReferences(parsedDocument, citationData, referenceData),
  ];

  return assembleRuleBasedReport({ parsedDocument, citationData, referenceData, parts });
}
