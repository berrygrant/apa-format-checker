function slugifyBaseName(filename) {
  const baseName = (filename || "apa-review").replace(/\.[^.]+$/, "");
  const normalized = baseName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "apa-review";
}

function titleCaseStatus(status) {
  return String(status || "warning")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function deriveIssueInventory(report) {
  const ruleBasedItems = (report.ruleBased?.sections || []).flatMap((section) =>
    (section.findings || []).map((finding) => ({
      source: "rule_based",
      sectionId: section.id,
      sectionLabel: section.label,
      status: finding.status,
      title: finding.title,
      detail: finding.detail,
      recommendation: finding.recommendation,
      evidence: finding.evidence || null,
      location: finding.location || null,
    })),
  );

  const llmItems = (report.llm?.sections || []).flatMap((section) =>
    (section.issues || []).map((issue) => ({
      source: "llm",
      sectionId: section.sectionId,
      sectionLabel: section.label,
      status: issue.severity,
      title: issue.title,
      detail: issue.detail,
      recommendation: issue.recommendation,
      evidence: issue.sourceExcerpt || null,
      location: issue.locationLabel
        ? {
            label: issue.locationLabel,
            excerpt: issue.sourceExcerpt || "",
          }
        : null,
    })),
  );

  return [...ruleBasedItems, ...llmItems];
}

function getIssueInventory(report) {
  return Array.isArray(report.issueInventory) ? report.issueInventory : deriveIssueInventory(report);
}

export function getComplianceIssues(report) {
  return getIssueInventory(report).filter((item) => item.status === "warning" || item.status === "fail");
}

function groupIssuesBySection(report) {
  const groups = new Map();

  for (const issue of getComplianceIssues(report)) {
    const key = `${issue.sectionId}:${issue.sectionLabel}`;
    const existing = groups.get(key);

    if (existing) {
      existing.items.push(issue);
    } else {
      groups.set(key, {
        sectionId: issue.sectionId,
        sectionLabel: issue.sectionLabel,
        items: [issue],
      });
    }
  }

  return [...groups.values()];
}

function buildMarkdownIssue(issue, index) {
  const locationLabel = issue.location?.label || "Location unavailable";
  const locationExcerpt = issue.location?.excerpt || issue.evidence || "";
  const lines = [
    `${index}. **${issue.title}**`,
    `   - Status: ${titleCaseStatus(issue.status)}`,
    `   - Source: ${issue.source === "llm" ? "OpenAI review" : "Rule-based review"}`,
    `   - Location: ${locationLabel}`,
    `   - Detail: ${issue.detail}`,
    `   - Recommendation: ${issue.recommendation}`,
  ];

  if (locationExcerpt) {
    lines.push(`   - Excerpt: ${locationExcerpt}`);
  }

  return lines.join("\n");
}

export function buildComplianceMarkdown(report) {
  const groupedIssues = groupIssuesBySection(report);
  const totalIssues = groupedIssues.reduce((sum, group) => sum + group.items.length, 0);
  const lines = [
    `# APA 7 Compliance Issues`,
    ``,
    `- Document: ${report.document.filename}`,
    `- Generated: ${report.generatedAt}`,
    `- Overall status: ${titleCaseStatus(report.summary.overallStatus)}`,
    `- Overall score: ${report.summary.overallScore}/100`,
    `- Total issues requiring attention: ${totalIssues}`,
    `- Location note: Best-effort line and reference-entry locations derived from extracted DOCX text`,
    ``,
    `## Summary`,
    ``,
    report.summary.headline,
    ``,
  ];

  if (groupedIssues.length === 0) {
    lines.push(`## Compliance Issues`, ``, `No warning-level or fail-level compliance issues were found in the final report.`, ``);
    return lines.join("\n");
  }

  lines.push(`## Compliance Issues`, ``);

  for (const group of groupedIssues) {
    lines.push(`### ${group.sectionLabel}`, ``);
    group.items.forEach((issue, index) => {
      lines.push(buildMarkdownIssue(issue, index + 1), ``);
    });
  }

  return lines.join("\n");
}

function triggerDownload(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export function downloadComplianceMarkdown(report) {
  const baseName = slugifyBaseName(report.document.filename);
  const markdown = buildComplianceMarkdown(report);

  triggerDownload(
    new Blob([markdown], {
      type: "text/markdown;charset=utf-8",
    }),
    `${baseName}-apa-compliance-issues.md`,
  );
}

export async function downloadComplianceDocx(report) {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
  const baseName = slugifyBaseName(report.document.filename);
  const groups = groupIssuesBySection(report);

  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      text: "APA 7 Compliance Issues",
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Document: ", bold: true }),
        new TextRun(report.document.filename),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Generated: ", bold: true }),
        new TextRun(report.generatedAt),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Overall status: ", bold: true }),
        new TextRun(titleCaseStatus(report.summary.overallStatus)),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Overall score: ", bold: true }),
        new TextRun(`${report.summary.overallScore}/100`),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Location note: ", bold: true }),
        new TextRun("Best-effort line and reference-entry locations derived from extracted DOCX text"),
      ],
    }),
    new Paragraph({
      text: "",
    }),
  ];

  if (groups.length === 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        text: "Compliance Issues",
      }),
      new Paragraph({
        text: "No warning-level or fail-level compliance issues were found in the final report.",
      }),
    );
  } else {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        text: "Compliance Issues",
      }),
    );

    for (const group of groups) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          text: group.sectionLabel,
        }),
      );

      group.items.forEach((issue, index) => {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            text: `${index + 1}. ${issue.title}`,
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "Status: ", bold: true }),
              new TextRun(titleCaseStatus(issue.status)),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "Source: ", bold: true }),
              new TextRun(issue.source === "llm" ? "OpenAI review" : "Rule-based review"),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "Location: ", bold: true }),
              new TextRun(issue.location?.label || "Location unavailable"),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "Detail: ", bold: true }),
              new TextRun(issue.detail),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "Recommendation: ", bold: true }),
              new TextRun(issue.recommendation),
            ],
          }),
        );

        if (issue.location?.excerpt || issue.evidence) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: "Excerpt: ", bold: true }),
                new TextRun(issue.location?.excerpt || issue.evidence),
              ],
            }),
          );
        }

        children.push(
          new Paragraph({
            text: "",
          }),
        );
      });
    }
  }

  const document = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(document);
  triggerDownload(blob, `${baseName}-apa-compliance-issues.docx`);
}
