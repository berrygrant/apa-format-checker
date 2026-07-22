import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Document, Packer, Paragraph, TextRun } from "docx";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function usage() {
  console.error("Usage: node scripts/smoke-review-stream.mjs <base-url>");
  process.exit(2);
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value || "").trim();

  if (!baseUrl) {
    usage();
  }

  return baseUrl.replace(/\/+$/, "");
}

function readPasswordFromSecret() {
  const secretId = process.env.SMOKE_SECRET_ID;

  if (!secretId) {
    return "";
  }

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const secretText = execFileSync(
    "aws",
    ["secretsmanager", "get-secret-value", "--region", region, "--secret-id", secretId, "--query", "SecretString", "--output", "text"],
    { encoding: "utf8" },
  ).trim();

  const secret = JSON.parse(secretText);
  return String(secret.APP_PASSWORD || "");
}

function extractCookieHeader(response) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);

  return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function createSmokeDocx() {
  const doubleSpaced = { line: 480, lineRule: "auto" };
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Times New Roman", size: 24 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children: [
          new Paragraph({
            alignment: "center",
            spacing: doubleSpaced,
            children: [new TextRun({ text: "Effects of Automated APA Feedback on Revision Confidence", bold: true })],
          }),
          new Paragraph({ text: "Grant Berry", spacing: doubleSpaced }),
          new Paragraph({ text: "Villanova University", spacing: doubleSpaced }),
          new Paragraph(""),
          new Paragraph({
            text: "Automated writing feedback can help students identify formatting concerns before submission.",
            spacing: doubleSpaced,
          }),
          new Paragraph({
            text: "Prior work suggests that formative feedback is most useful when it is specific and timely (Smith, 2022).",
            spacing: doubleSpaced,
          }),
          new Paragraph({
            text: "This smoke document intentionally includes a compact body so the parser and rule checks finish quickly.",
            spacing: doubleSpaced,
          }),
          new Paragraph(""),
          new Paragraph({ text: "References", spacing: doubleSpaced }),
          new Paragraph({
            spacing: doubleSpaced,
            indent: { hanging: 720 },
            children: [
              new TextRun({ text: "Smith, J. (2022). Writing feedback in psychology courses. " }),
              // The run-level reference-italics check expects an italicized
              // journal title in each entry.
              new TextRun({ text: "Journal of Teaching Practice", italics: true }),
              new TextRun({ text: ", 14(2), 22-31." }),
            ],
          }),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// The generated DOCX embeds build timestamps, so two invocations never
// produce byte-identical files. Setting SMOKE_FIXTURE_PATH persists the first
// generated fixture and reuses those exact bytes on later runs — required to
// exercise the server's byte-identical review cache with back-to-back runs.
async function loadSmokeDocx() {
  const fixturePath = process.env.SMOKE_FIXTURE_PATH;

  if (!fixturePath) {
    return createSmokeDocx();
  }

  if (existsSync(fixturePath)) {
    return readFile(fixturePath);
  }

  const buffer = await createSmokeDocx();
  await writeFile(fixturePath, buffer);
  return buffer;
}

function parseSseEvent(rawEvent) {
  const event = {
    type: "message",
    data: "",
  };

  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") {
      event.type = value || "message";
    } else if (field === "data") {
      event.data += event.data ? `\n${value}` : value;
    }
  }

  return event.data ? event : null;
}

async function readReviewStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  let finalReport = null;
  let streamError = null;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const rawEvents = buffer.split(/\r?\n\r?\n/);
    buffer = rawEvents.pop() ?? "";

    for (const rawEvent of rawEvents) {
      const event = parseSseEvent(rawEvent);
      if (!event) {
        continue;
      }

      const payload = JSON.parse(event.data);
      events.push(event.type);

      if (event.type === "llm_delta") {
        if (typeof payload.delta !== "string" || !Number.isFinite(payload.previewLength)) {
          throw new Error("llm_delta events must carry a string delta and numeric previewLength.");
        }

        if ("llmPreview" in payload) {
          throw new Error("llm_delta events must not resend the accumulated llmPreview buffer.");
        }
      }

      if (event.type === "complete") {
        finalReport = payload.report;
      } else if (event.type === "review_error") {
        streamError = payload.error?.message || "Review stream returned an error event.";
      }
    }
  }

  if (streamError) {
    throw new Error(streamError);
  }

  if (!finalReport) {
    throw new Error(`Review stream ended without a complete event. Events: ${events.join(", ")}`);
  }

  if (!Number.isFinite(finalReport.summary?.overallScore) || !Array.isArray(finalReport.ruleBased?.sections)) {
    throw new Error("Final report did not match the expected smoke-test shape.");
  }

  if (!Array.isArray(finalReport.issueInventory)) {
    throw new Error("Final report is missing the issueInventory array.");
  }

  // Reference verification must degrade gracefully: any status is acceptable
  // offline ("skipped", "unavailable", or a zero-lookup "completed"), but the
  // result object itself has to be present in the report.
  const verificationStatus = finalReport.referenceVerification?.status;

  if (!["completed", "skipped", "unavailable"].includes(verificationStatus)) {
    throw new Error(`Final report is missing a valid referenceVerification result (saw ${verificationStatus}).`);
  }

  const layoutSection = finalReport.ruleBased.sections.find((section) => section.id === "layout");

  if (!layoutSection) {
    throw new Error("The rule-based report is missing the layout section for a DOCX upload.");
  }

  if (finalReport.ruleBased.sections.length !== 6) {
    throw new Error(`Expected 6 rule-based sections, saw ${finalReport.ruleBased.sections.length}.`);
  }

  const marginFinding = layoutSection.findings.find((finding) => finding.title.startsWith("Margins"));

  if (!marginFinding || marginFinding.status !== "pass") {
    throw new Error("The smoke DOCX declares 1-inch margins, but the layout margin check did not pass.");
  }

  const deterministicIssues = finalReport.issueInventory.filter((issue) => issue.source === "rule_based");
  const inventoryFailCount = deterministicIssues.filter((issue) => issue.status === "fail").length;
  const inventoryWarningCount = deterministicIssues.filter((issue) => issue.status === "warning").length;

  if (finalReport.summary.failCount !== inventoryFailCount || finalReport.summary.warningCount !== inventoryWarningCount) {
    throw new Error(
      `Headline counts must match the deterministic issue inventory (fail ${finalReport.summary.failCount}/${inventoryFailCount}, warning ${finalReport.summary.warningCount}/${inventoryWarningCount}).`,
    );
  }

  return {
    events,
    finalReport,
  };
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.argv[2] || process.env.SMOKE_BASE_URL);
  const healthResponse = await fetch(`${baseUrl}/api/health`);

  if (!healthResponse.ok) {
    throw new Error(`Health check failed with HTTP ${healthResponse.status}.`);
  }

  let cookieHeader = "";
  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`);
  const session = await sessionResponse.json();

  if (session.enabled && !session.authenticated) {
    const password = process.env.SMOKE_APP_PASSWORD || process.env.APP_PASSWORD || readPasswordFromSecret();

    if (!password) {
      throw new Error("Password gate is enabled. Set SMOKE_APP_PASSWORD or SMOKE_SECRET_ID for the smoke test.");
    }

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });

    if (!loginResponse.ok) {
      throw new Error(`Login failed with HTTP ${loginResponse.status}.`);
    }

    cookieHeader = extractCookieHeader(loginResponse);
  }

  const formData = new FormData();
  const docxBuffer = await loadSmokeDocx();
  formData.append("file", new Blob([docxBuffer], { type: DOCX_MIME_TYPE }), "apa-smoke-test.docx");
  formData.append("reviewMode", "standard");

  const reviewResponse = await fetch(`${baseUrl}/api/review/stream`, {
    method: "POST",
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
    body: formData,
  });

  if (!reviewResponse.ok) {
    throw new Error(`Review stream failed with HTTP ${reviewResponse.status}: ${await reviewResponse.text()}`);
  }

  const { events, finalReport } = await readReviewStream(reviewResponse.body);
  console.log(
    JSON.stringify({
      ok: true,
      baseUrl,
      eventsReceived: events.length,
      completed: events.includes("complete"),
      overallStatus: finalReport.summary.overallStatus,
      overallScore: finalReport.summary.overallScore,
      sectionCount: finalReport.ruleBased.sections.length,
      cached: finalReport.cached === true,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
