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
  { label: "Literature Review", regex: /^\s*literature review\s*$/im },
  { label: "Method", regex: /^\s*method\s*$/im },
  { label: "Results", regex: /^\s*results\s*$/im },
  { label: "Discussion", regex: /^\s*discussion\s*$/im },
  { label: "Conclusion", regex: /^\s*conclusion\s*$/im },
];

const PARENTHETICAL_CITATION_REGEX = /\(([^()]*?(?:19|20)\d{2}[a-z]?[^()]*)\)/g;
const NARRATIVE_CITATION_REGEX = /\b([A-Z][A-Za-z'`-]+)\s+\(((?:19|20)\d{2}[a-z]?)\)/g;
const PAGE_CITATION_REGEX = /\b(?:p|pp|para)\.?\s*\d+/gi;
const MALFORMED_ET_AL_REGEX = /\bet\.?\s+al(?!\.)\b/gi;
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

function pairKey(author, year) {
  if (!author || !year) {
    return null;
  }

  return `${normalizeSurname(author)}-${year.toLowerCase()}`;
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

function extractCitationPairs(lineRecords) {
  const pairs = [];

  for (const lineRecord of lineRecords) {
    const parentheticalMatches = [...lineRecord.text.matchAll(PARENTHETICAL_CITATION_REGEX)];
    const narrativeMatches = [...lineRecord.text.matchAll(NARRATIVE_CITATION_REGEX)];

    for (const match of parentheticalMatches) {
      const groups = match[1]
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);

      for (const group of groups) {
        const authorMatch = group.match(/^([A-Z][A-Za-z'`-]+)/);
        const yearMatch = group.match(/((?:19|20)\d{2}[a-z]?)/);

        if (authorMatch && yearMatch) {
          pairs.push({
            author: authorMatch[1],
            year: yearMatch[1],
            raw: group,
            type: "parenthetical",
            key: pairKey(authorMatch[1], yearMatch[1]),
            lineNumber: lineRecord.lineNumber,
            paragraphNumber: lineRecord.paragraphNumber,
            lineText: lineRecord.text,
            location: buildLineLocation("citations", lineRecord),
          });
        }
      }
    }

    for (const match of narrativeMatches) {
      pairs.push({
        author: match[1],
        year: match[2],
        raw: match[0],
        type: "narrative",
        key: pairKey(match[1], match[2]),
        lineNumber: lineRecord.lineNumber,
        paragraphNumber: lineRecord.paragraphNumber,
        lineText: lineRecord.text,
        location: buildLineLocation("citations", lineRecord),
      });
    }
  }

  return pairs;
}

function extractReferencePairs(referenceEntryRecords) {
  return referenceEntryRecords.map((entryRecord) => {
    const authorMatch = entryRecord.text.match(/^([A-Z][A-Za-z'`-]+)\s*,/);
    const fallbackAuthorMatch = authorMatch ? null : entryRecord.text.match(/^([A-Z][A-Za-z'`-]+)/);
    const yearMatch = entryRecord.text.match(/\(((?:19|20)\d{2}[a-z]?)\)|\b((?:19|20)\d{2}[a-z]?)\b/);
    const author = authorMatch?.[1] ?? fallbackAuthorMatch?.[1] ?? "";
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
        !/https?:\/\/doi\.org\//i.test(entryRecord.text),
      entryNumber: entryRecord.entryNumber,
      startLine: entryRecord.startLine,
      endLine: entryRecord.endLine,
      location: buildReferenceLocation(entryRecord),
    };
  });
}

function buildCrossChecks(citationPairs, referencePairs) {
  const citationKeys = unique(citationPairs.map((pair) => pair.key));
  const referenceKeys = unique(referencePairs.map((pair) => pair.key));
  const referenceKeySet = new Set(referenceKeys);
  const citationKeySet = new Set(citationKeys);

  return {
    unmatchedCitations: citationKeys.filter((key) => !referenceKeySet.has(key)),
    uncitedReferences: referenceKeys.filter((key) => !citationKeySet.has(key)),
  };
}

function compareAlphabetically(referencePairs) {
  const authors = referencePairs
    .map((pair) => pair.author)
    .filter(Boolean)
    .map((author) => normalizeSurname(author));

  for (let index = 1; index < authors.length; index += 1) {
    if (authors[index - 1] > authors[index]) {
      return false;
    }
  }

  return true;
}

function findReferenceOrderingIssues(referencePairs) {
  const issues = [];

  for (let index = 1; index < referencePairs.length; index += 1) {
    const previous = referencePairs[index - 1];
    const current = referencePairs[index];
    const previousAuthor = normalizeSurname(previous.author || "");
    const currentAuthor = normalizeSurname(current.author || "");

    if (previousAuthor && currentAuthor && previousAuthor > currentAuthor) {
      issues.push({
        previous,
        current,
      });
    }
  }

  return issues;
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

      if (wordCount === 0 || wordCount > 16) {
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

function findQuotedSegmentsWithoutLocator(segmentRecords) {
  return segmentRecords.filter((segmentRecord) => {
    if (segmentRecord.zone !== "main") {
      return false;
    }

    const quoteCount = (segmentRecord.text.match(/["\u201c\u201d]/g) ?? []).length;
    if (quoteCount < 2) {
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

export function runRuleBasedReview(parsedDocument) {
  const citationPairs = extractCitationPairs(parsedDocument.bodyLineRecords);
  const referencePairs = extractReferencePairs(parsedDocument.referenceEntryRecords);
  const crossChecks = buildCrossChecks(citationPairs, referencePairs);
  const headingMatches = HEADING_PATTERNS.filter((item) => item.regex.test(parsedDocument.normalizedText)).map(
    (item) => item.label,
  );
  const numberedHeadingIssues = findHeadingNumberingIssues(parsedDocument.mainLineRecords);
  const malformedEtAlIssues = findMalformedEtAlOccurrences(parsedDocument.bodyLineRecords);
  const quoteLocatorIssues = findQuotedSegmentsWithoutLocator(parsedDocument.segmentRecords);
  const referenceOrderingIssues = findReferenceOrderingIssues(referencePairs);
  const pageCitationCount = [...parsedDocument.bodyText.matchAll(PAGE_CITATION_REGEX)].length;
  const titlePageLocation = buildSectionLocation("titlePage", parsedDocument.titlePageLineRecords, parsedDocument.titlePageText);
  const bodyLocation = buildSectionLocation("body", parsedDocument.bodyLineRecords, parsedDocument.bodyText);
  const referencesLocation = buildSectionLocation(
    "references",
    parsedDocument.referenceLineRecords,
    parsedDocument.referencesText,
    parsedDocument.referencesHeadingLineNumber
      ? `References section starting at line ${parsedDocument.referencesHeadingLineNumber}`
      : "References section location unavailable",
  );
  const documentEndLocation = buildLineLocation(
    "document",
    parsedDocument.mainLineRecords[parsedDocument.mainLineRecords.length - 1] ?? null,
    parsedDocument.mainLineRecords.length > 0
      ? `After line ${parsedDocument.mainLineRecords[parsedDocument.mainLineRecords.length - 1].lineNumber}`
      : "Document start",
  );

  const referenceKeySet = new Set(referencePairs.map((pair) => pair.key).filter(Boolean));
  const citationKeySet = new Set(citationPairs.map((pair) => pair.key).filter(Boolean));
  const unmatchedCitationPairs = citationPairs.filter((citationPair) => citationPair.key && !referenceKeySet.has(citationPair.key));
  const uncitedReferencePairs = referencePairs.filter((referencePair) => referencePair.key && !citationKeySet.has(referencePair.key));
  const missingYearReferences = referencePairs.filter((referencePair) => !referencePair.hasYear);
  const referenceFormattingIssues = referencePairs.filter(
    (referencePair) => referencePair.hasBareDoi || referencePair.hasRetrievedFrom,
  );

  const itemIssues = [];

  if (parsedDocument.parserMessages.length > 0) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "document",
        sectionLabel: "Document Structure",
        status: "warning",
        title: "DOCX extraction warning",
        detail: "Mammoth returned parsing warnings that may affect downstream APA checks.",
        recommendation: "Inspect the DOCX for unsupported elements such as text boxes or embedded objects.",
        location: buildSectionLocation("document", parsedDocument.mainLineRecords, parsedDocument.preReferencesText),
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
        recommendation: "Confirm that the DOCX contains selectable text rather than scanned content.",
        location: buildSectionLocation("document", parsedDocument.mainLineRecords, parsedDocument.preReferencesText),
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
        recommendation: 'Add a "References" heading and ensure it appears as plain body text in the DOCX.',
        location: documentEndLocation,
      }),
    );
  }

  if (parsedDocument.metrics.titlePageWords < 40) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "titlePage",
        sectionLabel: "Title Page",
        status: "warning",
        title: "Sparse title-page text",
        detail: `Only ${parsedDocument.metrics.titlePageWords} title-page words were extracted.`,
        recommendation: "Confirm that the title page content is present as editable text in the DOCX.",
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

  if (!/\bby\b/i.test(parsedDocument.titlePageText) && !/\bsubmitted\b/i.test(parsedDocument.titlePageText)) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "titlePage",
        sectionLabel: "Title Page",
        status: "warning",
        title: "Authorship cue not obvious",
        detail: "The parser did not clearly detect an authorship line in the title-page excerpt.",
        recommendation: "Check that the student name and thesis title appear on separate lines in APA order.",
        location: titlePageLocation,
      }),
    );
  }

  if (parsedDocument.metrics.bodyWords < 300) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "body",
        sectionLabel: "Body and Headings",
        status: "warning",
        title: "Short body excerpt",
        detail: `Only ${parsedDocument.metrics.bodyWords} body words were captured for review.`,
        recommendation: "Verify that body text starts after the title page and remains selectable in the DOCX.",
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
        detail: "The parsed DOCX has relatively few paragraph breaks, which can hide heading and spacing issues.",
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

  for (const unmatchedCitationPair of unmatchedCitationPairs) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "citations",
        sectionLabel: "Citations",
        status: "fail",
        title: "In-text citation missing from references",
        detail: `The citation "${unmatchedCitationPair.raw}" could not be matched to a reference entry.`,
        recommendation: "Add the corresponding reference entry or correct the author-year formatting mismatch.",
        location: unmatchedCitationPair.location,
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
        recommendation: "Ensure the references heading is plain body text and that entries remain in editable DOCX text.",
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
        recommendation: "Check the references heading and paragraph breaks in the DOCX.",
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

  for (const orderingIssue of referenceOrderingIssues) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "references",
        sectionLabel: "References",
        status: "warning",
        title: "Reference entry out of alphabetical order",
        detail: `The entry "${orderingIssue.current.raw}" appears after "${orderingIssue.previous.raw}" but sorts earlier alphabetically.`,
        recommendation: "Sort the References section alphabetically by the first author surname.",
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

  const documentSection = buildSection(
    "document",
    "Document Structure",
    "Checks whether the parser extracted enough structured text to run the APA review reliably.",
    [
      parsedDocument.parserMessages.length === 0
        ? makeFinding("pass", "DOCX extraction", "The document parsed cleanly with Mammoth.", "No parser remediation needed.")
        : makeFinding(
            "warning",
            "DOCX extraction",
            "Mammoth returned parsing warnings that may affect some downstream checks.",
            "Inspect the source DOCX for unusual elements such as text boxes or embedded objects.",
            parsedDocument.parserMessages.map((message) => message.message).join(" | "),
            buildSectionLocation("document", parsedDocument.mainLineRecords, parsedDocument.preReferencesText),
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
            "Confirm that the DOCX contains selectable text rather than scanned content.",
            null,
            buildSectionLocation("document", parsedDocument.mainLineRecords, parsedDocument.preReferencesText),
          ),
      parsedDocument.referencesMissing
        ? makeFinding(
            "fail",
            "References heading missing",
            'A standalone "References" heading was not detected in the parsed text.',
            'Add a "References" heading and ensure it appears as plain body text in the DOCX.',
            null,
            documentEndLocation,
          )
        : makeFinding(
            "pass",
            "References heading detected",
            "A references section was identified in the parsed document.",
            "Keep the heading on its own line so it remains detectable.",
            null,
            parsedDocument.referencesHeadingLineNumber
              ? makeLocation({
                  sectionId: "document",
                  lineStart: parsedDocument.referencesHeadingLineNumber,
                  lineEnd: parsedDocument.referencesHeadingLineNumber,
                  excerpt: "References",
                  labelOverride: `References heading at line ${parsedDocument.referencesHeadingLineNumber}`,
                })
              : null,
          ),
    ],
    {
      wordCount: parsedDocument.wordCount,
      parserMessageCount: parsedDocument.parserMessages.length,
      referenceEntryCount: parsedDocument.metrics.referenceEntryCount,
    },
  );

  const titlePageSection = buildSection(
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
            "Confirm that the title page content is present as editable text in the DOCX.",
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
      /\bby\b/i.test(parsedDocument.titlePageText) || /\bsubmitted\b/i.test(parsedDocument.titlePageText)
        ? makeFinding(
            "pass",
            "Authorship cue detected",
            'The title-page excerpt contains an authorship cue such as "by" or "submitted".',
            "Confirm exact line order manually in Word.",
          )
        : makeFinding(
            "warning",
            "Authorship cue not obvious",
            "The parser did not clearly detect an authorship line in the title-page excerpt.",
            "Check that the student name and thesis title appear on separate lines in APA order.",
            null,
            titlePageLocation,
          ),
    ],
    {
      excerptWordCount: parsedDocument.metrics.titlePageWords,
    },
  );

  const bodySection = buildSection(
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
            "Verify that body text starts after the title page and remains selectable in the DOCX.",
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
            "The parsed DOCX has relatively few paragraph breaks, which can hide heading and spacing issues.",
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

  const citationsSection = buildSection(
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
      unmatchedCitationPairs.length === 0
        ? makeFinding(
            "pass",
            "Citations matched to references",
            "Every detectable citation pair in the excerpt was found in the extracted references.",
            "No action required.",
          )
        : makeFinding(
            unmatchedCitationPairs.length >= 3 ? "fail" : "warning",
            "Citations missing from references",
            `${unmatchedCitationPairs.length} in-text citation${unmatchedCitationPairs.length === 1 ? "" : "s"} could not be matched to the references list.`,
            "Check author-year consistency between in-text citations and the References section.",
            null,
            unmatchedCitationPairs[0].location,
          ),
    ],
    {
      citationCount: citationPairs.length,
      pageCitationCount,
      unmatchedCitationCount: unmatchedCitationPairs.length,
      malformedEtAlCount: malformedEtAlIssues.length,
    },
  );

  const referencesSection = buildSection(
    "references",
    "References",
    "Checks reference list presence, rough entry structure, ordering, and citation crosswalks.",
    [
      parsedDocument.referencesMissing
        ? makeFinding(
            "fail",
            "Reference list not extracted",
            'The parser could not extract entries after a "References" heading.',
            "Ensure the references heading is plain body text and that entries remain in editable DOCX text.",
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
            "Check the references heading and paragraph breaks in the DOCX.",
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
      compareAlphabetically(referencePairs)
        ? makeFinding(
            "pass",
            "Alphabetical ordering looks correct",
            "The reference entries appear alphabetized by first author surname.",
            "No action required.",
          )
        : makeFinding(
            "warning",
            "Alphabetical ordering may be incorrect",
            `Detected ${referenceOrderingIssues.length} reference entr${referenceOrderingIssues.length === 1 ? "y" : "ies"} out of order.`,
            "Sort the References section alphabetically by the first author surname.",
            null,
            referenceOrderingIssues[0]?.current?.location ?? referencesLocation,
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

  const sections = [documentSection, titlePageSection, bodySection, citationsSection, referencesSection];
  const orderedSections = SECTION_ORDER.map((sectionId) => sections.find((section) => section.id === sectionId)).filter(Boolean);
  const allFindings = orderedSections.flatMap((section) => section.findings);
  const passCount = allFindings.filter((finding) => finding.status === "pass").length;
  const warningCount = allFindings.filter((finding) => finding.status === "warning").length;
  const failCount = allFindings.filter((finding) => finding.status === "fail").length;
  const overallStatus = orderedSections.reduce((status, section) => worstStatus(status, section.status), "pass");
  const overallScore = Math.max(0, 100 - failCount * 15 - warningCount * 6);

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
      citationCount: citationPairs.length,
      referenceCount: referencePairs.length,
      headingCount: headingMatches.length,
      numberedHeadingIssueCount: numberedHeadingIssues.length,
      itemIssueCount: itemIssues.length,
    },
    limitations: buildReviewLimitations(parsedDocument),
  };
}
