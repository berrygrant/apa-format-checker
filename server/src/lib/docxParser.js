import { DEFAULT_REVIEW_MODE, getReviewModeConfig } from "./reviewMode.js";

export const REFERENCES_HEADING_REGEX = /^\s*(references|reference list|bibliography|works cited)\s*:?\s*$/i;

// The LAST plausible heading wins so a table-of-contents entry near the top of
// the document cannot hijack the main/references split.
export function findReferencesHeading(rawLines) {
  let result = { index: -1, label: null };

  rawLines.forEach((line, index) => {
    const match = line.trim().match(REFERENCES_HEADING_REGEX);

    if (match) {
      result = { index, label: match[1] };
    }
  });

  return result;
}

function normalizeText(input) {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function tokenize(text) {
  return text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function excerpt(text, wordCount) {
  const words = tokenize(text);
  if (words.length <= wordCount) {
    return words.join(" ");
  }

  return `${words.slice(0, wordCount).join(" ")}...`;
}

function buildLineRecords(rawLines, referencesHeadingIndex) {
  const lineRecords = [];
  let paragraphNumber = 0;
  let insideParagraph = false;

  rawLines.forEach((rawLine, index) => {
    const text = rawLine.trim();

    if (!text) {
      insideParagraph = false;
      return;
    }

    if (!insideParagraph) {
      paragraphNumber += 1;
      insideParagraph = true;
    }

    lineRecords.push({
      lineNumber: index + 1,
      paragraphNumber,
      text,
      zone: referencesHeadingIndex !== -1 && index > referencesHeadingIndex ? "references" : "main",
    });
  });

  return lineRecords;
}

function buildSegmentRecords(rawLines, referencesHeadingIndex) {
  const segments = [];
  let currentLines = [];
  let currentStartLine = null;

  function flushSegment(endIndex) {
    if (currentLines.length === 0 || currentStartLine === null) {
      return;
    }

    const segmentNumber = segments.length + 1;
    const zone = referencesHeadingIndex !== -1 && currentStartLine > referencesHeadingIndex + 1 ? "references" : "main";

    segments.push({
      segmentNumber,
      paragraphNumber: segmentNumber,
      lineStart: currentStartLine,
      lineEnd: endIndex,
      text: currentLines.join(" ").replace(/\s+/g, " ").trim(),
      zone,
    });

    currentLines = [];
    currentStartLine = null;
  }

  rawLines.forEach((rawLine, index) => {
    const text = rawLine.trim();
    const lineNumber = index + 1;

    if (!text) {
      flushSegment(lineNumber - 1);
      return;
    }

    if (currentStartLine === null) {
      currentStartLine = lineNumber;
    }

    currentLines.push(text);
  });

  flushSegment(rawLines.length);
  return segments;
}

function splitMainLinesByWordBudget(mainLineRecords, titleWordLimit, bodyWordLimit) {
  const titlePageLineRecords = [];
  const bodyLineRecords = [];
  let runningWordCount = 0;

  for (const lineRecord of mainLineRecords) {
    const lineWordCount = tokenize(lineRecord.text).length;

    if (runningWordCount < titleWordLimit) {
      titlePageLineRecords.push(lineRecord);
    } else if (bodyLineRecords.length === 0 || runningWordCount < titleWordLimit + bodyWordLimit) {
      bodyLineRecords.push(lineRecord);
    }

    runningWordCount += lineWordCount;
  }

  if (bodyLineRecords.length === 0) {
    return {
      titlePageLineRecords,
      bodyLineRecords: mainLineRecords,
    };
  }

  return {
    titlePageLineRecords,
    bodyLineRecords,
  };
}

function extractReferenceEntryRecords(rawLines, referencesHeadingIndex) {
  if (referencesHeadingIndex === -1) {
    return [];
  }

  const groupedEntries = [];
  let currentLines = [];
  let currentStartLine = null;

  function flushEntry(endIndex) {
    if (currentLines.length === 0 || currentStartLine === null) {
      return;
    }

    groupedEntries.push({
      startLine: currentStartLine,
      endLine: endIndex,
      text: currentLines.join(" ").replace(/\s+/g, " ").trim(),
    });

    currentLines = [];
    currentStartLine = null;
  }

  for (let index = referencesHeadingIndex + 1; index < rawLines.length; index += 1) {
    const text = rawLines[index].trim();
    const lineNumber = index + 1;

    if (!text) {
      flushEntry(lineNumber - 1);
      continue;
    }

    if (currentStartLine === null) {
      currentStartLine = lineNumber;
    }

    currentLines.push(text);
  }

  flushEntry(rawLines.length);

  if (groupedEntries.length > 1) {
    return groupedEntries.map((entry, index) => ({
      entryNumber: index + 1,
      ...entry,
    }));
  }

  const singleLineEntries = rawLines
    .slice(referencesHeadingIndex + 1)
    .map((rawLine, index) => ({
      text: rawLine.trim(),
      lineNumber: referencesHeadingIndex + index + 2,
    }))
    .filter((entry) => entry.text)
    .map((entry, index) => ({
      entryNumber: index + 1,
      text: entry.text,
      startLine: entry.lineNumber,
      endLine: entry.lineNumber,
    }));

  return singleLineEntries;
}

let mammothModulePromise = null;
let pdfParseModulePromise = null;

function loadMammoth() {
  mammothModulePromise ??= import("mammoth").catch((error) => {
    mammothModulePromise = null;
    throw error;
  });

  return mammothModulePromise;
}

function loadPdfParse() {
  pdfParseModulePromise ??= import("pdf-parse").catch((error) => {
    pdfParseModulePromise = null;
    throw error;
  });

  return pdfParseModulePromise;
}

// Kicks both parser imports so a Lambda cold start absorbs the module-load
// cost during init instead of the first user review. Failures reset the cache
// so the next request retries lazily.
export function warmParsers() {
  loadMammoth().catch(() => {});
  loadPdfParse().catch(() => {});
}

async function extractDocxRawText(buffer) {
  const { default: mammoth } = await loadMammoth();
  const result = await mammoth.extractRawText({ buffer });

  return {
    sourceFormat: "docx",
    sourceLabel: "DOCX",
    rawText: result.value ?? "",
    parserMessages: result.messages ?? [],
  };
}

async function extractPdfRawText(buffer) {
  const { PDFParse } = await loadPdfParse();
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();

    return {
      sourceFormat: "pdf",
      sourceLabel: "PDF",
      rawText: result.text ?? "",
      parserMessages: [],
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export function buildParsedDocument(rawExtraction, options = {}) {
  const reviewMode = options.reviewMode ?? DEFAULT_REVIEW_MODE;
  const reviewModeConfig = getReviewModeConfig(reviewMode);
  const { titlePageWords, bodyWords, referencesWords, annotatedTitleLines, annotatedBodyLines, annotatedReferenceEntries } =
    reviewModeConfig.extraction;
  const normalizedText = normalizeText(rawExtraction.rawText ?? "");
  const rawLines = normalizedText ? normalizedText.split("\n") : [];
  const { index: referencesHeadingIndex, label: referencesHeadingLabel } = findReferencesHeading(rawLines);
  const lineRecords = buildLineRecords(rawLines, referencesHeadingIndex);
  const segmentRecords = buildSegmentRecords(rawLines, referencesHeadingIndex);
  const mainLineRecords = lineRecords.filter((lineRecord) => lineRecord.zone === "main");
  const referenceLineRecords = lineRecords.filter((lineRecord) => lineRecord.zone === "references");
  const { titlePageLineRecords, bodyLineRecords } = splitMainLinesByWordBudget(
    mainLineRecords,
    titlePageWords,
    bodyWords,
  );

  const preReferencesText =
    referencesHeadingIndex === -1 ? normalizedText : rawLines.slice(0, referencesHeadingIndex).join("\n").trim();
  const referencesText =
    referencesHeadingIndex === -1 ? "" : rawLines.slice(referencesHeadingIndex + 1).join("\n").trim();
  const referenceEntryRecords = extractReferenceEntryRecords(rawLines, referencesHeadingIndex);

  return {
    reviewMode,
    sourceFormat: rawExtraction.sourceFormat,
    sourceLabel: rawExtraction.sourceLabel,
    extractionWindow: {
      titlePageWords,
      bodyWords,
      referencesWords,
      annotatedTitleLines,
      annotatedBodyLines,
      annotatedReferenceEntries,
    },
    rawText: rawExtraction.rawText ?? "",
    normalizedText,
    lines: lineRecords.map((lineRecord) => lineRecord.text),
    lineRecords,
    mainLineRecords,
    referenceLineRecords,
    titlePageLineRecords,
    bodyLineRecords,
    segments: segmentRecords.map((segmentRecord) => segmentRecord.text),
    segmentRecords,
    parserMessages: rawExtraction.parserMessages ?? [],
    titlePageText: titlePageLineRecords.map((lineRecord) => lineRecord.text).join(" "),
    bodyText: bodyLineRecords.map((lineRecord) => lineRecord.text).join(" "),
    preReferencesText,
    referencesText,
    referencesHeadingLineNumber: referencesHeadingIndex === -1 ? null : referencesHeadingIndex + 1,
    referencesHeadingLabel,
    referencesMissing: referencesHeadingIndex === -1 || referenceEntryRecords.length === 0,
    referenceEntries: referenceEntryRecords.map((entryRecord) => entryRecord.text),
    referenceEntryRecords,
    wordCount: tokenize(normalizedText).length,
    metrics: {
      titlePageWords: tokenize(titlePageLineRecords.map((lineRecord) => lineRecord.text).join(" ")).length,
      bodyWords: tokenize(bodyLineRecords.map((lineRecord) => lineRecord.text).join(" ")).length,
      referencesWords: tokenize(referencesText).length,
      referenceEntryCount: referenceEntryRecords.length,
    },
  };
}

export async function parseDocumentBuffer(buffer, fileMeta, options = {}) {
  const filename = String(fileMeta?.name ?? "").toLowerCase();
  const mimeType = String(fileMeta?.mimeType ?? "").toLowerCase();
  const isPdf = filename.endsWith(".pdf") || mimeType === "application/pdf";

  if (isPdf) {
    return buildParsedDocument(await extractPdfRawText(buffer), options);
  }

  return buildParsedDocument(await extractDocxRawText(buffer), options);
}

export async function parseDocxBuffer(buffer, options = {}) {
  return buildParsedDocument(await extractDocxRawText(buffer), options);
}

export function summarizeParsedDocument(parsedDocument) {
  return {
    sourceFormat: parsedDocument.sourceFormat,
    sourceLabel: parsedDocument.sourceLabel,
    wordCount: parsedDocument.wordCount,
    referencesMissing: parsedDocument.referencesMissing,
    referenceEntryCount: parsedDocument.metrics.referenceEntryCount,
    parserMessages: parsedDocument.parserMessages.map((message) => ({
      type: message.type,
      message: message.message,
    })),
    previews: {
      titlePage: excerpt(parsedDocument.titlePageText, 40),
      body: excerpt(parsedDocument.bodyText, 70),
      references: excerpt(parsedDocument.referencesText, 50),
    },
  };
}
