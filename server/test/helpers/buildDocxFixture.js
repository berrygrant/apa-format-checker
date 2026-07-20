import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

const DEFAULT_MARGIN_TWIPS = 1440;

function toRuns(content, { bold = false } = {}) {
  if (typeof content === "string") {
    return [new TextRun({ text: content, bold })];
  }

  return content;
}

function buildParagraph(spec, defaults = {}) {
  if (typeof spec === "string") {
    spec = { text: spec };
  }

  const options = {
    children: toRuns(spec.text ?? "", { bold: spec.bold ?? false }),
  };

  if (spec.heading) {
    options.heading = spec.heading;
  }

  if (spec.centered) {
    options.alignment = AlignmentType.CENTER;
  }

  const spacing = spec.spacing ?? defaults.spacing;
  if (spacing) {
    options.spacing = spacing;
  }

  const indent = spec.indent ?? defaults.indent;
  if (indent) {
    options.indent = indent;
  }

  return new Paragraph(options);
}

/**
 * Builds an in-memory DOCX buffer for tests.
 *
 * Options:
 * - paragraphs: Array<string | {text, bold, centered, heading, spacing, indent}>
 * - referenceEntries: Array<string> rendered after a "References" paragraph with hanging indents
 * - margins: {top, right, bottom, left} in twips (default 1440 each)
 * - defaultFont / defaultSizePt: document-default run properties
 * - doubleSpaced: apply {line: 480, lineRule: "auto"} to body paragraphs
 * - firstLineIndent: twips applied to body paragraphs
 * - hangingIndent: twips applied to reference paragraphs (default 720 when referenceEntries given)
 * - pageNumbers: add a footer with a PAGE field
 * - useHeadingStyles: render {heading: "Heading1"|...} paragraph specs with Word heading styles
 */
export async function buildDocxBuffer({
  paragraphs = [],
  referenceEntries = [],
  referencesLabel = "References",
  margins = {},
  defaultFont = null,
  defaultSizePt = null,
  doubleSpaced = false,
  firstLineIndent = null,
  hangingIndent = referenceEntries.length > 0 ? 720 : null,
  pageNumbers = false,
  useHeadingStyles = false,
} = {}) {
  const bodyDefaults = {
    spacing: doubleSpaced ? { line: 480, lineRule: "auto" } : undefined,
    indent: firstLineIndent ? { firstLine: firstLineIndent } : undefined,
  };

  const children = paragraphs.map((spec) => {
    if (typeof spec !== "string" && spec.heading && useHeadingStyles) {
      return buildParagraph({ ...spec, heading: HeadingLevel[spec.heading.toUpperCase().replace("HEADING", "HEADING_")] ?? spec.heading }, bodyDefaults);
    }

    if (typeof spec !== "string" && spec.heading && !useHeadingStyles) {
      const { heading, ...rest } = spec;
      return buildParagraph(rest, bodyDefaults);
    }

    return buildParagraph(spec, bodyDefaults);
  });

  if (referenceEntries.length > 0) {
    children.push(buildParagraph({ text: referencesLabel }, bodyDefaults));
    for (const entry of referenceEntries) {
      children.push(
        buildParagraph(
          {
            text: entry,
            indent: hangingIndent ? { hanging: hangingIndent } : undefined,
            spacing: bodyDefaults.spacing,
          },
        ),
      );
    }
  }

  const section = {
    properties: {
      page: {
        margin: {
          top: margins.top ?? DEFAULT_MARGIN_TWIPS,
          right: margins.right ?? DEFAULT_MARGIN_TWIPS,
          bottom: margins.bottom ?? DEFAULT_MARGIN_TWIPS,
          left: margins.left ?? DEFAULT_MARGIN_TWIPS,
        },
      },
    },
    children,
  };

  if (pageNumbers) {
    section.footers = {
      default: new Footer({
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ children: [PageNumber.CURRENT] })],
          }),
        ],
      }),
    };
    section.headers = {
      default: new Header({ children: [new Paragraph("")] }),
    };
  }

  const documentOptions = { sections: [section] };

  if (defaultFont || defaultSizePt) {
    documentOptions.styles = {
      default: {
        document: {
          run: {
            ...(defaultFont ? { font: defaultFont } : {}),
            ...(defaultSizePt ? { size: defaultSizePt * 2 } : {}),
          },
        },
      },
    };
  }

  const doc = new Document(documentOptions);
  return Packer.toBuffer(doc);
}
