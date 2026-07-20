import { REFERENCES_HEADING_REGEX } from "./docxParser.js";

const WML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export const TWIPS_PER_INCH = 1440;
export const HALF_INCH_TWIPS = 720;
export const DOUBLE_SPACING_LINE = 480;

function wVal(element, name = "val") {
  if (!element) {
    return null;
  }

  // Producers vary in how they register the w: namespace, so fall back from
  // namespace-aware lookup to the prefixed and bare attribute names.
  return (
    element.getAttributeNS?.(WML_NS, name) ||
    element.getAttribute?.(`w:${name}`) ||
    element.getAttribute?.(name) ||
    null
  );
}

function twips(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function elems(node, localName) {
  if (!node?.getElementsByTagNameNS) {
    return [];
  }

  // xmldom's NodeList is index-addressable but not spread-iterable.
  const nodeList = node.getElementsByTagNameNS(WML_NS, localName);
  const result = [];

  for (let index = 0; index < nodeList.length; index += 1) {
    result.push(nodeList.item ? nodeList.item(index) : nodeList[index]);
  }

  return result;
}

function firstElem(node, localName) {
  return elems(node, localName)[0] ?? null;
}

function directChild(node, localName) {
  if (!node) {
    return null;
  }

  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.localName === localName && child.namespaceURI === WML_NS) {
      return child;
    }
  }

  return null;
}

function isFlagEnabled(element) {
  if (!element) {
    return false;
  }

  const value = wVal(element);
  return value === null || !/^(?:0|false|none)$/i.test(value);
}

function paragraphText(paragraph) {
  return elems(paragraph, "t")
    .map((textNode) => textNode.textContent ?? "")
    .join("")
    .trim();
}

function mostCommon(values) {
  if (values.length === 0) {
    return null;
  }

  const counts = new Map();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
}

async function readXml(zip, path, DOMParser) {
  const file = zip.file(path);

  if (!file) {
    return null;
  }

  const xml = await file.async("string");
  return new DOMParser().parseFromString(xml, "text/xml");
}

function readMargins(documentDoc) {
  const sectPrs = elems(documentDoc, "sectPr");

  if (sectPrs.length === 0) {
    return null;
  }

  // The final sectPr governs the main body section.
  const pgMar = firstElem(sectPrs[sectPrs.length - 1], "pgMar");

  if (!pgMar) {
    return null;
  }

  return {
    top: twips(wVal(pgMar, "top")),
    right: twips(wVal(pgMar, "right")),
    bottom: twips(wVal(pgMar, "bottom")),
    left: twips(wVal(pgMar, "left")),
    gutter: twips(wVal(pgMar, "gutter")),
  };
}

function readPageSize(documentDoc) {
  const sectPrs = elems(documentDoc, "sectPr");

  if (sectPrs.length === 0) {
    return null;
  }

  const pgSz = firstElem(sectPrs[sectPrs.length - 1], "pgSz");

  if (!pgSz) {
    return null;
  }

  return {
    width: twips(wVal(pgSz, "w")),
    height: twips(wVal(pgSz, "h")),
  };
}

function readRunDefaults(container) {
  const rPr = firstElem(container, "rPr");

  if (!rPr) {
    return { family: null, sizeHalfPoints: null };
  }

  const rFonts = firstElem(rPr, "rFonts");
  const sz = firstElem(rPr, "sz");

  return {
    family: wVal(rFonts, "ascii") || wVal(rFonts, "hAnsi") || null,
    sizeHalfPoints: twips(wVal(sz)),
  };
}

function findStyle(stylesDoc, styleId) {
  for (const style of elems(stylesDoc, "style")) {
    if (wVal(style, "styleId") === styleId) {
      return style;
    }
  }

  return null;
}

function readDefaultFont(stylesDoc) {
  if (!stylesDoc) {
    return { family: null, sizePt: null };
  }

  const docDefaults = firstElem(stylesDoc, "docDefaults");
  const rPrDefault = firstElem(docDefaults, "rPrDefault");
  const defaults = readRunDefaults(rPrDefault);
  const normalStyle = findStyle(stylesDoc, "Normal");
  const normalDefaults = normalStyle ? readRunDefaults(normalStyle) : { family: null, sizeHalfPoints: null };

  const family = normalDefaults.family || defaults.family;
  const sizeHalfPoints = normalDefaults.sizeHalfPoints ?? defaults.sizeHalfPoints;

  return {
    family,
    sizePt: sizeHalfPoints === null ? null : sizeHalfPoints / 2,
  };
}

function readSpacingDefaults(stylesDoc) {
  if (!stylesDoc) {
    return null;
  }

  const docDefaults = firstElem(stylesDoc, "docDefaults");
  const pPrDefault = firstElem(docDefaults, "pPrDefault");
  const defaultSpacing = firstElem(pPrDefault, "spacing");
  const normalStyle = findStyle(stylesDoc, "Normal");
  const normalSpacing = normalStyle ? firstElem(firstElem(normalStyle, "pPr"), "spacing") : null;

  return normalSpacing ?? defaultSpacing ?? null;
}

function spacingFromElement(spacingElement) {
  if (!spacingElement) {
    return null;
  }

  return {
    line: twips(wVal(spacingElement, "line")),
    lineRule: wVal(spacingElement, "lineRule"),
    after: twips(wVal(spacingElement, "after")),
  };
}

function isDoubleSpaced(spacing) {
  if (!spacing || spacing.line === null) {
    return false;
  }

  return spacing.line >= DOUBLE_SPACING_LINE && (!spacing.lineRule || spacing.lineRule === "auto");
}

function collectBodyParagraphs(documentDoc) {
  const body = firstElem(documentDoc, "body");
  const paragraphs = [];

  for (const paragraph of elems(body, "p")) {
    const text = paragraphText(paragraph);

    if (text) {
      paragraphs.push({ node: paragraph, text });
    }
  }

  return paragraphs;
}

function splitAtReferencesHeading(paragraphs) {
  let referencesIndex = -1;

  paragraphs.forEach((paragraph, index) => {
    if (REFERENCES_HEADING_REGEX.test(paragraph.text)) {
      referencesIndex = index;
    }
  });

  if (referencesIndex === -1) {
    return { mainParagraphs: paragraphs, referenceParagraphs: [] };
  }

  return {
    mainParagraphs: paragraphs.slice(0, referencesIndex),
    referenceParagraphs: paragraphs.slice(referencesIndex + 1),
  };
}

function readSpacing(paragraphs, stylesDoc) {
  const inheritedSpacing = spacingFromElement(readSpacingDefaults(stylesDoc));
  const sampled = [];

  for (const paragraph of paragraphs) {
    const pPr = directChild(paragraph.node, "pPr");
    const ownSpacing = spacingFromElement(directChild(pPr, "spacing"));
    sampled.push(ownSpacing ?? inheritedSpacing);
  }

  const known = sampled.filter(Boolean);
  const doubleSpacedCount = sampled.filter((spacing) => isDoubleSpaced(spacing)).length;
  const spaceAfterCount = known.filter((spacing) => (spacing.after ?? 0) > 0).length;

  return {
    sampledParagraphs: sampled.length,
    doubleSpacedRatio: sampled.length === 0 ? 0 : doubleSpacedCount / sampled.length,
    dominantLine: mostCommon(known.map((spacing) => spacing.line).filter((value) => value !== null)),
    dominantLineRule: mostCommon(known.map((spacing) => spacing.lineRule).filter(Boolean)),
    spaceAfterRatio: sampled.length === 0 ? 0 : spaceAfterCount / sampled.length,
  };
}

function readIndentation(mainParagraphs, referenceParagraphs) {
  const bodyFirstLineValues = [];

  for (const paragraph of mainParagraphs) {
    const pPr = directChild(paragraph.node, "pPr");
    const ind = directChild(pPr, "ind");
    bodyFirstLineValues.push(twips(wVal(ind, "firstLine")) ?? 0);
  }

  const referenceHangingValues = [];

  for (const paragraph of referenceParagraphs) {
    const pPr = directChild(paragraph.node, "pPr");
    const ind = directChild(pPr, "ind");
    referenceHangingValues.push(twips(wVal(ind, "hanging")) ?? 0);
  }

  const indentedBodyCount = bodyFirstLineValues.filter((value) => value >= 360).length;
  const hangingReferenceCount = referenceHangingValues.filter((value) => value >= 360).length;

  return {
    body: {
      sampled: bodyFirstLineValues.length,
      firstLineRatio: bodyFirstLineValues.length === 0 ? 0 : indentedBodyCount / bodyFirstLineValues.length,
      dominantFirstLine: mostCommon(bodyFirstLineValues.filter((value) => value > 0)),
    },
    references: {
      sampled: referenceHangingValues.length,
      hangingRatio: referenceHangingValues.length === 0 ? 0 : hangingReferenceCount / referenceHangingValues.length,
      dominantHanging: mostCommon(referenceHangingValues.filter((value) => value > 0)),
    },
  };
}

function readPageNumbering(headerFooterDocs) {
  for (const doc of headerFooterDocs) {
    for (const field of elems(doc, "fldSimple")) {
      if (/\bPAGE\b/i.test(wVal(field, "instr") ?? "")) {
        return { hasPageNumberField: true };
      }
    }

    for (const instruction of elems(doc, "instrText")) {
      if (/\bPAGE\b/i.test(instruction.textContent ?? "")) {
        return { hasPageNumberField: true };
      }
    }
  }

  return { hasPageNumberField: false };
}

function readHeadingStyles(paragraphs) {
  const levelsUsed = new Set();
  let count = 0;

  for (const paragraph of paragraphs) {
    const pPr = directChild(paragraph.node, "pPr");

    if (!pPr) {
      continue;
    }

    const styleId = wVal(directChild(pPr, "pStyle"), "val") ?? "";
    const headingMatch = styleId.match(/^Heading([1-9])$/i);

    if (headingMatch) {
      count += 1;
      levelsUsed.add(Number.parseInt(headingMatch[1], 10));
      continue;
    }

    const outlineLevel = twips(wVal(directChild(pPr, "outlineLvl"), "val"));

    if (outlineLevel !== null && outlineLevel < 9) {
      count += 1;
      levelsUsed.add(outlineLevel + 1);
    }
  }

  return {
    count,
    levelsUsed: [...levelsUsed].sort((left, right) => left - right),
    usesWordHeadingStyles: count > 0,
  };
}

function paragraphHasPageBreak(paragraph) {
  return elems(paragraph, "br").some((breakElement) => wVal(breakElement, "type") === "page");
}

function readTitlePage(documentDoc) {
  const body = firstElem(documentDoc, "body");
  const summaries = [];

  for (const paragraph of elems(body, "p")) {
    if (summaries.length >= 8 || (summaries.length > 0 && paragraphHasPageBreak(paragraph))) {
      break;
    }

    const text = paragraphText(paragraph);

    if (!text) {
      continue;
    }

    const pPr = directChild(paragraph, "pPr");
    const centered = wVal(directChild(pPr, "jc"), "val") === "center";
    const bold = elems(paragraph, "r").some((run) => isFlagEnabled(directChild(directChild(run, "rPr"), "b")));

    summaries.push({ text, bold, centered });
  }

  return {
    paragraphs: summaries,
    hasBoldCenteredTitle: summaries.some((paragraph) => paragraph.bold && paragraph.centered),
  };
}

// Reads the layout facts APA cares about straight from the DOCX XML: margins,
// default font, line spacing, indentation, page-number fields, Word heading
// styles, and title-page emphasis. Absent parts yield nulls, never throws for
// missing headers/footers/styles.
export async function extractDocxLayout(buffer) {
  const { default: JSZip } = await import("jszip");
  const { DOMParser } = await import("@xmldom/xmldom");
  const zip = await JSZip.loadAsync(buffer);
  const documentDoc = await readXml(zip, "word/document.xml", DOMParser);

  if (!documentDoc) {
    throw new Error("The DOCX package does not contain word/document.xml.");
  }

  const stylesDoc = await readXml(zip, "word/styles.xml", DOMParser);
  const headerFooterFiles = zip.file(/^word\/(?:header|footer)\d*\.xml$/);
  const headerFooterDocs = [];

  for (const file of headerFooterFiles) {
    const parsed = await readXml(zip, file.name, DOMParser);

    if (parsed) {
      headerFooterDocs.push(parsed);
    }
  }

  const paragraphs = collectBodyParagraphs(documentDoc);
  const { mainParagraphs, referenceParagraphs } = splitAtReferencesHeading(paragraphs);

  return {
    available: true,
    margins: readMargins(documentDoc),
    pageSize: readPageSize(documentDoc),
    defaultFont: readDefaultFont(stylesDoc),
    spacing: readSpacing(paragraphs, stylesDoc),
    indentation: readIndentation(mainParagraphs, referenceParagraphs),
    pageNumbering: readPageNumbering(headerFooterDocs),
    headingStyles: readHeadingStyles(paragraphs),
    titlePage: readTitlePage(documentDoc),
  };
}
