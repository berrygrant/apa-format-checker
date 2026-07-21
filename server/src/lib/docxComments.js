const COMMENTS_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const COMMENTS_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const WML_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const COMMENTS_PATH = "word/comments.xml";
const CONTENT_TYPES_PATH = "[Content_Types].xml";
const DOCUMENT_PATH = "word/document.xml";
const DOCUMENT_RELS_PATH = "word/_rels/document.xml.rels";

const MAX_ISSUES = 200;
const MAX_COMMENTS_PER_PARAGRAPH = 3;
const MATCH_PREFIX_WORDS = 8;
const MIN_NEEDLE_LENGTH = 4;
const MAX_TEXT_LENGTH = 2000;

const MINIMAL_COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${WML_NAMESPACE}"></w:comments>`;
const MINIMAL_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

// Opening/self-closing <w:p ...> tags and </w:p> closers. The lookahead keeps
// <w:pPr>, <w:pStyle>, <w:pgMar>, etc. from matching.
const PARAGRAPH_TAG_REGEX = /<w:p(?=[\s/>])[^>]*>|<\/w:p\s*>/g;
const SELF_CLOSING_PPR_REGEX = /^\s*<w:pPr(?:\s[^>]*)?\/>/;
const OPEN_PPR_REGEX = /^\s*<w:pPr(?:\s[^>]*)?>/;
// w:t content plus the run elements that render as whitespace or a hyphen.
const TEXT_TOKEN_REGEX = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t\s*>|<w:(noBreakHyphen)(?:\s[^>]*)?\/>|<w:(?:tab|br|cr)(?:\s[^>]*)?\/>/g;
const COMMENT_ID_IN_COMMENTS_REGEX = /<w:comment\s[^>]*w:id="(\d+)"/g;
const COMMENT_ID_IN_DOCUMENT_REGEX = /<w:comment(?:RangeStart|RangeEnd|Reference)\s[^>]*w:id="(\d+)"/g;

function cleanString(value, maxLength = MAX_TEXT_LENGTH) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

// Keeps only the string fields the annotator uses; everything else in the
// (client-supplied) issue payload is dropped. Returns null when the input is
// not an array so callers can reject the request outright.
export function sanitizeAnnotationIssues(rawIssues) {
  if (!Array.isArray(rawIssues)) {
    return null;
  }

  return rawIssues.slice(0, MAX_ISSUES).map((rawIssue) => {
    const issue = rawIssue && typeof rawIssue === "object" ? rawIssue : {};
    const location = issue.location && typeof issue.location === "object" ? issue.location : {};

    return {
      id: cleanString(issue.id, 200),
      status: cleanString(issue.status, 40),
      title: cleanString(issue.title, 300),
      detail: cleanString(issue.detail),
      recommendation: cleanString(issue.recommendation),
      evidence: cleanString(issue.evidence),
      location: {
        excerpt: cleanString(location.excerpt),
      },
    };
  });
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeCodePoint(codePoint) {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function decodeXmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => decodeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => decodeCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeForMatch(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractParagraphText(innerXml) {
  const parts = [];
  let match;

  TEXT_TOKEN_REGEX.lastIndex = 0;
  while ((match = TEXT_TOKEN_REGEX.exec(innerXml)) !== null) {
    if (match[1] !== undefined) {
      parts.push(decodeXmlEntities(match[1]));
    } else if (match[2] !== undefined) {
      parts.push("-");
    } else {
      parts.push(" ");
    }
  }

  return parts.join("");
}

// Length of the leading <w:pPr> block (if any), so range starts land after the
// paragraph properties — commentRangeStart before w:pPr is schema-invalid.
function measurePropertiesPrefix(innerXml) {
  const selfClosing = innerXml.match(SELF_CLOSING_PPR_REGEX);

  if (selfClosing) {
    return selfClosing[0].length;
  }

  const open = innerXml.match(OPEN_PPR_REGEX);

  if (!open) {
    return 0;
  }

  const closeIndex = innerXml.indexOf("</w:pPr>", open[0].length);
  return closeIndex === -1 ? 0 : closeIndex + "</w:pPr>".length;
}

// Scans document.xml as text for outermost <w:p> spans. Paragraphs nested in
// text boxes stay inside their outer paragraph's span, and table-cell
// paragraphs are ordinary top-level targets.
function collectParagraphs(documentXml) {
  const paragraphs = [];
  const stack = [];
  let match;

  PARAGRAPH_TAG_REGEX.lastIndex = 0;
  while ((match = PARAGRAPH_TAG_REGEX.exec(documentXml)) !== null) {
    const tag = match[0];

    if (tag.startsWith("</")) {
      const openTag = stack.pop();

      if (openTag && stack.length === 0) {
        const innerXml = documentXml.slice(openTag.innerStart, match.index);
        paragraphs.push({
          innerStart: openTag.innerStart,
          innerEnd: match.index,
          anchorStart: openTag.innerStart + measurePropertiesPrefix(innerXml),
          matchText: normalizeForMatch(extractParagraphText(innerXml)),
          commentCount: 0,
        });
      }

      continue;
    }

    if (tag.endsWith("/>")) {
      continue;
    }

    stack.push({ innerStart: match.index + tag.length });
  }

  return paragraphs;
}

// Try the full normalized excerpt first, then a leading-words prefix, so
// truncated or lightly paraphrased excerpts still find their paragraph.
function buildMatchNeedles(issue) {
  const source = issue.location?.excerpt || issue.evidence || "";
  const withoutEllipsis = String(source).replace(/(?:\.{3}|\u2026)\s*$/, "");
  const normalized = normalizeForMatch(withoutEllipsis);

  if (normalized.length < MIN_NEEDLE_LENGTH) {
    return [];
  }

  const words = normalized.split(" ");
  const needles = [normalized];

  if (words.length > MATCH_PREFIX_WORDS) {
    needles.push(words.slice(0, MATCH_PREFIX_WORDS).join(" "));
  }

  return needles;
}

function findAnchorParagraph(paragraphs, needles) {
  for (const needle of needles) {
    for (const paragraph of paragraphs) {
      if (paragraph.commentCount < MAX_COMMENTS_PER_PARAGRAPH && paragraph.matchText.includes(needle)) {
        return paragraph;
      }
    }
  }

  return null;
}

function buildCommentText(issue) {
  const severity = (issue.status || "issue").toUpperCase();
  const headlineParts = [`[${severity}]`];

  if (issue.title) {
    headlineParts.push(issue.title);
  }

  if (issue.detail) {
    headlineParts.push(`— ${issue.detail}`);
  }

  const paragraphs = [headlineParts.join(" ")];

  if (issue.recommendation) {
    paragraphs.push(`Fix: ${issue.recommendation}`);
  }

  return paragraphs;
}

function buildCommentXml(issue, commentId, isoDate) {
  const body = buildCommentText(issue)
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join("");

  return `<w:comment w:id="${commentId}" w:author="APA Format Checker" w:initials="APA" w:date="${isoDate}">${body}</w:comment>`;
}

function findNextCommentId(existingCommentsXml, documentXml) {
  let maxId = -1;

  for (const [regex, xml] of [
    [COMMENT_ID_IN_COMMENTS_REGEX, existingCommentsXml],
    [COMMENT_ID_IN_DOCUMENT_REGEX, documentXml],
  ]) {
    for (const match of (xml ?? "").matchAll(regex)) {
      const id = Number.parseInt(match[1], 10);

      if (Number.isFinite(id)) {
        maxId = Math.max(maxId, id);
      }
    }
  }

  return maxId + 1;
}

// Inserts a fragment just before the root element's closing tag, expanding a
// self-closing root (<w:comments .../>) when necessary.
function insertIntoRoot(xml, rootTagName, fragment, partLabel) {
  const closeTag = `</${rootTagName}>`;
  const closeIndex = xml.lastIndexOf(closeTag);

  if (closeIndex !== -1) {
    return xml.slice(0, closeIndex) + fragment + xml.slice(closeIndex);
  }

  if (new RegExp(`<${rootTagName}(?:\\s[^>]*)?/>\\s*$`).test(xml)) {
    const selfCloseIndex = xml.lastIndexOf("/>");
    return `${xml.slice(0, selfCloseIndex)}>${fragment}${closeTag}${xml.slice(selfCloseIndex + 2)}`;
  }

  throw new Error(`The DOCX part ${partLabel} could not be updated with Word comments.`);
}

function ensureCommentsContentType(contentTypesXml) {
  if (!contentTypesXml) {
    throw new Error(`The DOCX package does not contain ${CONTENT_TYPES_PATH}.`);
  }

  if (contentTypesXml.includes(`PartName="/${COMMENTS_PATH}"`)) {
    return contentTypesXml;
  }

  const override = `<Override ContentType="${COMMENTS_CONTENT_TYPE}" PartName="/${COMMENTS_PATH}"/>`;
  return insertIntoRoot(contentTypesXml, "Types", override, CONTENT_TYPES_PATH);
}

function ensureCommentsRelationship(relsXml) {
  const baseXml = relsXml || MINIMAL_RELS_XML;

  if (baseXml.includes(COMMENTS_RELATIONSHIP_TYPE)) {
    return baseXml;
  }

  let counter = 1;

  for (const match of baseXml.matchAll(/Id="rId(\d+)"/g)) {
    counter = Math.max(counter, Number.parseInt(match[1], 10) + 1);
  }

  while (baseXml.includes(`Id="rId${counter}"`)) {
    counter += 1;
  }

  const relationship = `<Relationship Id="rId${counter}" Type="${COMMENTS_RELATIONSHIP_TYPE}" Target="comments.xml"/>`;
  return insertIntoRoot(baseXml, "Relationships", relationship, DOCUMENT_RELS_PATH);
}

// Splices insertion fragments into the original string without touching any
// other byte. Equal positions keep their sequence order.
function applyInsertions(source, insertions) {
  const ordered = [...insertions].sort(
    (left, right) => left.position - right.position || left.sequence - right.sequence,
  );
  const pieces = [];
  let cursor = 0;

  for (const insertion of ordered) {
    pieces.push(source.slice(cursor, insertion.position), insertion.text);
    cursor = insertion.position;
  }

  pieces.push(source.slice(cursor));
  return pieces.join("");
}

async function readZipText(zip, path) {
  const file = zip.file(path);
  return file ? file.async("string") : null;
}

/**
 * Returns a copy of the DOCX buffer with one native Word comment anchored to
 * the first paragraph whose text contains each issue's excerpt (or evidence).
 * Whole paragraphs are annotated — runs are never split — and each paragraph
 * accepts at most three comments. The original word/document.xml is edited as
 * text so untouched markup survives byte-for-byte.
 *
 * @returns {{ buffer: Buffer, anchoredCount: number, unanchoredCount: number, unanchored: Array<object> }}
 */
export async function annotateDocxWithIssues(buffer, issues) {
  const sanitizedIssues = sanitizeAnnotationIssues(issues);

  if (!sanitizedIssues) {
    throw new Error("issues must be an array of issue objects.");
  }

  const { default: JSZip } = await import("jszip");
  let zip;

  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("The uploaded file could not be opened as a DOCX package.");
  }

  const documentXml = await readZipText(zip, DOCUMENT_PATH);

  if (!documentXml) {
    throw new Error(`The DOCX package does not contain ${DOCUMENT_PATH}.`);
  }

  const paragraphs = collectParagraphs(documentXml);
  const anchored = [];
  const unanchored = [];

  for (const issue of sanitizedIssues) {
    const paragraph = findAnchorParagraph(paragraphs, buildMatchNeedles(issue));

    if (paragraph) {
      paragraph.commentCount += 1;
      anchored.push({ issue, paragraph });
    } else {
      unanchored.push(issue);
    }
  }

  if (anchored.length === 0) {
    return {
      buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
      anchoredCount: 0,
      unanchoredCount: unanchored.length,
      unanchored,
    };
  }

  const existingCommentsXml = await readZipText(zip, COMMENTS_PATH);
  const isoDate = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const commentFragments = [];
  const insertions = [];
  let commentId = findNextCommentId(existingCommentsXml, documentXml);
  let sequence = 0;

  for (const { issue, paragraph } of anchored) {
    const id = commentId;
    commentId += 1;

    commentFragments.push(buildCommentXml(issue, id, isoDate));
    insertions.push({
      position: paragraph.anchorStart,
      sequence: sequence++,
      text: `<w:commentRangeStart w:id="${id}"/>`,
    });
    insertions.push({
      position: paragraph.innerEnd,
      sequence: sequence++,
      text: `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`,
    });
  }

  const commentsXml = insertIntoRoot(
    existingCommentsXml || MINIMAL_COMMENTS_XML,
    "w:comments",
    commentFragments.join(""),
    COMMENTS_PATH,
  );

  zip.file(DOCUMENT_PATH, applyInsertions(documentXml, insertions));
  zip.file(COMMENTS_PATH, commentsXml);
  zip.file(CONTENT_TYPES_PATH, ensureCommentsContentType(await readZipText(zip, CONTENT_TYPES_PATH)));
  zip.file(DOCUMENT_RELS_PATH, ensureCommentsRelationship(await readZipText(zip, DOCUMENT_RELS_PATH)));

  const annotatedBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return {
    buffer: annotatedBuffer,
    anchoredCount: anchored.length,
    unanchoredCount: unanchored.length,
    unanchored,
  };
}
