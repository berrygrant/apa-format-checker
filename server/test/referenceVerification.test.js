import assert from "node:assert/strict";
import test from "node:test";

import {
  applyVerificationToReferencesPart,
  extractDoi,
  verifyReferences,
} from "../src/lib/referenceVerification.js";
import { createJob } from "../src/lib/jobStore.js";
import { processReviewJob } from "../src/lib/reviewJob.js";
import { analyzeReferences, extractCitationData, extractReferenceData } from "../src/lib/ruleChecks.js";
import { buildDocxBuffer } from "./helpers/buildDocxFixture.js";
import { parseRawText } from "./helpers/textFixtures.js";

function makePair(entryNumber, raw, year = "2020") {
  return {
    raw,
    author: "Smith",
    year,
    key: `smith-${year}`,
    hasBareDoi: false,
    hasLegacyDoiUrl: false,
    entryNumber,
    startLine: entryNumber,
    endLine: entryNumber,
    location: {
      sectionId: "references",
      lineStart: entryNumber,
      lineEnd: entryNumber,
      paragraphNumber: null,
      entryNumber,
      label: `References entry ${entryNumber}`,
      excerpt: raw,
    },
  };
}

const MATCHING_ENTRY = makePair(
  1,
  "Smith, J. (2020). Sleep and memory consolidation in adults. Journal of Sleep, 5(1), 1-10. https://doi.org/10.1037/a0018883",
);

function crossrefBody({ title = "Sleep and memory consolidation in adults", years = [2020], containerTitle = "Journal of Sleep" } = {}) {
  const [issued, print, online] = years;

  return {
    status: "ok",
    message: {
      title: [title],
      "container-title": [containerTitle],
      ...(issued ? { issued: { "date-parts": [[issued]] } } : {}),
      ...(print ? { "published-print": { "date-parts": [[print]] } } : {}),
      ...(online ? { "published-online": { "date-parts": [[online]] } } : {}),
    },
  };
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function throwingFetch() {
  return recordingFetch(() => {
    throw new Error("verification should not have queried the network");
  });
}

test("extractDoi finds the DOI and strips trailing punctuation", () => {
  assert.equal(
    extractDoi("Smith, J. (2020). Sleep. Journal, 5(1), 1-10. https://doi.org/10.1037/a0018883."),
    "10.1037/a0018883",
  );
  assert.equal(extractDoi("… (doi: 10.1000/xyz123),"), "10.1000/xyz123");
  assert.equal(extractDoi("Walker, M. (2017). Why we sleep. Scribner."), null);
  assert.equal(extractDoi(""), null);
});

test("a matching CrossRef record verifies the entry", async () => {
  const fetchImpl = recordingFetch(() => okResponse(crossrefBody()));
  const verification = await verifyReferences([MATCHING_ENTRY], { enabled: true, fetchImpl, mailto: "smoke@example.com" });

  assert.equal(verification.status, "completed");
  assert.equal(verification.checked, 1);
  assert.equal(verification.verified, 1);
  assert.equal(verification.mismatched, 0);
  assert.equal(verification.unresolved, 0);
  assert.equal(verification.results.length, 1);
  assert.equal(verification.results[0].outcome, "verified");
  assert.equal(verification.results[0].entryNumber, 1);
  assert.equal(verification.results[0].doi, "10.1037/a0018883");
  assert.deepEqual(verification.results[0].crossref, {
    title: "Sleep and memory consolidation in adults",
    year: 2020,
    containerTitle: "Journal of Sleep",
  });

  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].url.startsWith("https://api.crossref.org/works/10.1037%2Fa0018883"));
  assert.ok(fetchImpl.calls[0].url.includes("mailto=smoke%40example.com"));
  assert.ok(fetchImpl.calls[0].init.signal instanceof AbortSignal);
});

test("a CrossRef year that differs from the entry year is a year_mismatch", async () => {
  const fetchImpl = recordingFetch(() => okResponse(crossrefBody({ years: [2018] })));
  const verification = await verifyReferences([MATCHING_ENTRY], { enabled: true, fetchImpl });

  assert.equal(verification.status, "completed");
  assert.equal(verification.mismatched, 1);
  assert.equal(verification.results[0].outcome, "year_mismatch");
  assert.match(verification.results[0].detail, /2018/);
  assert.match(verification.results[0].detail, /2020/);
  assert.equal(verification.results[0].crossref.year, 2018);
});

test("an entry year matching the published-online year still verifies", async () => {
  const fetchImpl = recordingFetch(() => okResponse(crossrefBody({ years: [2019, 2019, 2020] })));
  const verification = await verifyReferences([MATCHING_ENTRY], { enabled: true, fetchImpl });

  assert.equal(verification.results[0].outcome, "verified");
  assert.equal(verification.results[0].crossref.year, 2019);
});

test("a CrossRef title with low overlap is a title_mismatch", async () => {
  const crossrefTitle = "Quarterly earnings forecasts under managerial hubris";
  const fetchImpl = recordingFetch(() => okResponse(crossrefBody({ title: crossrefTitle })));
  const verification = await verifyReferences([MATCHING_ENTRY], { enabled: true, fetchImpl });

  assert.equal(verification.status, "completed");
  assert.equal(verification.mismatched, 1);
  assert.equal(verification.results[0].outcome, "title_mismatch");
  assert.ok(verification.results[0].detail.includes(crossrefTitle));
});

test("HTTP 404 maps to not_found and counts as unresolved", async () => {
  const fetchImpl = recordingFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
  const verification = await verifyReferences([MATCHING_ENTRY], { enabled: true, fetchImpl });

  assert.equal(verification.status, "completed");
  assert.equal(verification.unresolved, 1);
  assert.equal(verification.results[0].outcome, "not_found");
  assert.equal(verification.results[0].crossref, null);
  assert.match(verification.results[0].detail, /10\.1037\/a0018883/);
});

test("timeouts abort the request and an all-error run is unavailable", async () => {
  const fetchImpl = recordingFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const abortError = new Error("This operation was aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      }),
  );
  const verification = await verifyReferences([MATCHING_ENTRY], { enabled: true, fetchImpl, timeoutMs: 20 });

  assert.equal(verification.status, "unavailable");
  assert.equal(verification.errored, 1);
  assert.equal(verification.results[0].outcome, "error");
  assert.match(verification.results[0].detail, /timed out after 20ms/);
});

test("a mix of success and network failure stays completed", async () => {
  const secondEntry = makePair(2, "Lee, K. (2020). Another study. Journal, 1(1), 1-3. https://doi.org/10.5555/broken");
  const fetchImpl = recordingFetch((url) => {
    if (url.includes("10.5555%2Fbroken")) {
      throw new TypeError("fetch failed");
    }

    return okResponse(crossrefBody());
  });
  const verification = await verifyReferences([MATCHING_ENTRY, secondEntry], { enabled: true, fetchImpl });

  assert.equal(verification.status, "completed");
  assert.equal(verification.checked, 2);
  assert.equal(verification.verified, 1);
  assert.equal(verification.errored, 1);
  assert.match(verification.results[1].detail, /fetch failed/);
});

test("the total budget stops new lookups and marks the rest as errors", async () => {
  const pairs = [1, 2, 3].map((entryNumber) =>
    makePair(entryNumber, `Smith, J. (2020). Sleep study ${entryNumber}. Journal, 1(1), 1-3. https://doi.org/10.1037/slow.${entryNumber}`),
  );
  const fetchImpl = recordingFetch(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(okResponse(crossrefBody({ title: "Sleep study" }))), 60);
      }),
  );
  const verification = await verifyReferences(pairs, {
    enabled: true,
    fetchImpl,
    concurrency: 1,
    totalBudgetMs: 30,
  });

  assert.equal(verification.status, "completed");
  assert.equal(verification.checked, 3);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(verification.results[0].outcome, "verified");
  assert.equal(verification.results[1].outcome, "error");
  assert.equal(verification.results[1].detail, "time budget exhausted");
  assert.equal(verification.results[2].detail, "time budget exhausted");
});

test("entries without a DOI are counted but never queried", async () => {
  const noDoiA = makePair(2, "Walker, M. (2017). Why we sleep. Scribner.", "2017");
  const noDoiB = makePair(3, "Duncan, R. (2019). Field notes on attention. Attention Press.", "2019");
  const fetchImpl = recordingFetch(() => okResponse(crossrefBody()));
  const verification = await verifyReferences([MATCHING_ENTRY, noDoiA, noDoiB], { enabled: true, fetchImpl });

  assert.equal(verification.status, "completed");
  assert.equal(verification.totalEntries, 3);
  assert.equal(verification.checked, 1);
  assert.equal(verification.withoutDoi, 2);
  assert.equal(fetchImpl.calls.length, 1);
});

test("an all-no-DOI list completes with zero lookups and no network use", async () => {
  const fetchImpl = throwingFetch();
  const verification = await verifyReferences([makePair(1, "Walker, M. (2017). Why we sleep. Scribner.", "2017")], {
    enabled: true,
    fetchImpl,
  });

  assert.equal(verification.status, "completed");
  assert.equal(verification.checked, 0);
  assert.equal(verification.withoutDoi, 1);
  assert.deepEqual(verification.results, []);
  assert.equal(fetchImpl.calls.length, 0);
});

test("the off switch and empty reference lists skip without touching the network", async () => {
  const fetchImpl = throwingFetch();

  const disabled = await verifyReferences([MATCHING_ENTRY], { enabled: false, fetchImpl });
  assert.equal(disabled.status, "skipped");
  assert.deepEqual(disabled.results, []);

  const empty = await verifyReferences([], { enabled: true, fetchImpl });
  assert.equal(empty.status, "skipped");
  assert.equal(fetchImpl.calls.length, 0);
});

const VERIFIABLE_DOCUMENT = [
  "Automated Reference Checks",
  "",
  "Evidence keeps accumulating (Jones, 2021). Sleep remains central to cognition (Smith, 2020).",
  "",
  "References",
  "Jones, A. (2021). Imaginary results in applied psychology. Journal of Made Up Studies, 2(1), 5-10. https://doi.org/10.9999/fake.123",
  "",
  "Smith, J. (2020). Sleep and memory consolidation in adults. Journal of Sleep, 5(1), 1-10. https://doi.org/10.1037/a0018883",
].join("\n");

function buildReferencesPart() {
  const parsedDocument = parseRawText(VERIFIABLE_DOCUMENT);
  const citationData = extractCitationData(parsedDocument.bodyLineRecords);
  const referenceData = extractReferenceData(parsedDocument);

  return {
    referencesPart: analyzeReferences(parsedDocument, citationData, referenceData),
    referencePairs: referenceData.referencePairs,
  };
}

test("unresolvable DOIs append a fail finding and a per-entry fail item issue", async () => {
  const { referencesPart, referencePairs } = buildReferencesPart();
  const fetchImpl = recordingFetch((url) =>
    url.includes("10.9999%2Ffake.123")
      ? { ok: false, status: 404, json: async () => ({}) }
      : okResponse(crossrefBody()),
  );
  const verification = await verifyReferences(referencePairs, { enabled: true, fetchImpl });
  const merged = applyVerificationToReferencesPart(referencesPart, verification, referencePairs);

  assert.equal(verification.status, "completed");
  assert.equal(verification.unresolved, 1);

  const summaryFinding = merged.section.findings.find((finding) => finding.title === "Unresolvable DOIs in references");
  assert.ok(summaryFinding);
  assert.equal(summaryFinding.status, "fail");
  assert.equal(merged.section.status, "fail");
  assert.equal(merged.section.summary, referencesPart.section.summary);

  const doiIssue = merged.itemIssues.find((issue) => issue.title === "DOI does not resolve");
  assert.ok(doiIssue);
  assert.equal(doiIssue.status, "fail");
  assert.equal(doiIssue.location?.entryNumber, 1);
  assert.match(doiIssue.recommendation, /hallmark of fabricated references/);

  for (const finding of referencesPart.section.findings) {
    assert.ok(merged.section.findings.some((candidate) => candidate.id === finding.id));
  }
});

test("metadata mismatches append warning item issues quoting CrossRef", async () => {
  const { referencesPart, referencePairs } = buildReferencesPart();
  const fetchImpl = recordingFetch((url) =>
    url.includes("10.9999%2Ffake.123")
      ? okResponse(crossrefBody({ title: "Imaginary results in applied psychology", years: [2016] }))
      : okResponse(crossrefBody({ title: "Completely unrelated metallurgy handbook chapters" })),
  );
  const verification = await verifyReferences(referencePairs, { enabled: true, fetchImpl });
  const merged = applyVerificationToReferencesPart(referencesPart, verification, referencePairs);

  assert.equal(verification.mismatched, 2);

  const yearIssue = merged.itemIssues.find((issue) => issue.title === "Reference year differs from CrossRef");
  assert.ok(yearIssue);
  assert.equal(yearIssue.status, "warning");
  assert.match(yearIssue.detail, /2016/);

  const titleIssue = merged.itemIssues.find((issue) => issue.title === "Reference title differs from CrossRef");
  assert.ok(titleIssue);
  assert.match(titleIssue.detail, /Completely unrelated metallurgy handbook chapters/);

  const summaryFinding = merged.section.findings.find(
    (finding) => finding.title === "CrossRef metadata differs for some references",
  );
  assert.ok(summaryFinding);
  assert.equal(summaryFinding.status, "warning");
});

test("an all-verified run appends the pass finding with counts", async () => {
  const { referencesPart, referencePairs } = buildReferencesPart();
  const fetchImpl = recordingFetch((url) =>
    url.includes("10.9999%2Ffake.123")
      ? okResponse(crossrefBody({ title: "Imaginary results in applied psychology", years: [2021] }))
      : okResponse(crossrefBody()),
  );
  const verification = await verifyReferences(referencePairs, { enabled: true, fetchImpl });
  const merged = applyVerificationToReferencesPart(referencesPart, verification, referencePairs);

  const passFinding = merged.section.findings.find((finding) => finding.title === "References verified against CrossRef");
  assert.ok(passFinding);
  assert.equal(passFinding.status, "pass");
  assert.match(passFinding.detail, /2 verified/);
  assert.equal(merged.itemIssues.length, referencesPart.itemIssues.length);
});

test("an unavailable run appends one info finding and leaves status and issues alone", async () => {
  const { referencesPart, referencePairs } = buildReferencesPart();
  const fetchImpl = recordingFetch(() => {
    throw new TypeError("fetch failed");
  });
  const verification = await verifyReferences(referencePairs, { enabled: true, fetchImpl });
  const merged = applyVerificationToReferencesPart(referencesPart, verification, referencePairs);

  assert.equal(verification.status, "unavailable");
  assert.equal(merged.section.findings.length, referencesPart.section.findings.length + 1);

  const infoFinding = merged.section.findings.find(
    (finding) => finding.title === "Reference verification unavailable (network)",
  );
  assert.ok(infoFinding);
  assert.equal(infoFinding.status, "info");
  assert.equal(merged.section.status, referencesPart.section.status);
  assert.equal(merged.section.score, referencesPart.section.score);
  assert.equal(merged.itemIssues.length, referencesPart.itemIssues.length);
});

test("a zero-DOI completed run appends only an informational coverage note", async () => {
  const parsedDocument = parseRawText(
    ["A Study", "", "Sleep matters (Walker, 2017).", "", "References", "Walker, M. (2017). Why we sleep. Scribner."].join("\n"),
  );
  const citationData = extractCitationData(parsedDocument.bodyLineRecords);
  const referenceData = extractReferenceData(parsedDocument);
  const referencesPart = analyzeReferences(parsedDocument, citationData, referenceData);
  const verification = await verifyReferences(referenceData.referencePairs, { enabled: true, fetchImpl: throwingFetch() });
  const merged = applyVerificationToReferencesPart(referencesPart, verification, referenceData.referencePairs);

  assert.equal(verification.status, "completed");
  assert.equal(verification.checked, 0);

  const infoFinding = merged.section.findings.find((finding) => finding.title === "No DOI-bearing references to verify");
  assert.ok(infoFinding);
  assert.equal(infoFinding.status, "info");
  assert.match(infoFinding.detail, /Only DOI-bearing entries are verified/);
  assert.equal(merged.itemIssues.length, referencesPart.itemIssues.length);
});

test("a skipped verification leaves the references part untouched", () => {
  const { referencesPart } = buildReferencesPart();
  const merged = applyVerificationToReferencesPart(referencesPart, { status: "skipped", results: [] }, []);

  assert.equal(merged, referencesPart);
});

test("processReviewJob wires CrossRef verification into the stream and the final report", async () => {
  delete process.env.OPENAI_API_KEY;

  const buffer = await buildDocxBuffer({
    paragraphs: [
      "Automated Reference Checks",
      "Grant Berry",
      "Villanova University",
      "",
      "Evidence keeps accumulating (Jones, 2021). Sleep remains central to cognition (Smith, 2020).",
    ],
    referenceEntries: [
      "Jones, A. (2021). Imaginary results in applied psychology. Journal of Made Up Studies, 2(1), 5-10. https://doi.org/10.9999/fake.123",
      "Smith, J. (2020). Sleep and memory consolidation in adults. Journal of Sleep, 5(1), 1-10. https://doi.org/10.1037/a0018883",
    ],
  });
  const job = createJob({
    id: "job-reference-verification-integration",
    fileMeta: {
      name: "verification.docx",
      sizeBytes: buffer.length,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    reviewMode: "standard",
  });
  const fetchImpl = recordingFetch((url) =>
    url.includes("10.9999%2Ffake.123") ? { ok: false, status: 404, json: async () => ({}) } : okResponse(crossrefBody()),
  );

  await processReviewJob(job, buffer, { referenceVerification: { enabled: true, fetchImpl } });

  assert.equal(job.error, null);
  assert.equal(job.status, "completed");

  const report = job.report;
  assert.equal(report.version, "3.2.0");
  assert.equal(report.referenceVerification.status, "completed");
  assert.equal(report.referenceVerification.checked, 2);
  assert.equal(report.referenceVerification.verified, 1);
  assert.equal(report.referenceVerification.unresolved, 1);

  const referencesSection = report.ruleBased.sections.find((section) => section.id === "references");
  assert.ok(referencesSection.findings.some((finding) => finding.title === "Unresolvable DOIs in references"));

  const doiIssue = report.issueInventory.find((issue) => issue.title === "DOI does not resolve");
  assert.ok(doiIssue);
  assert.equal(doiIssue.status, "fail");
  assert.equal(doiIssue.location?.entryNumber, 1);

  const inventoryFailCount = report.issueInventory.filter((issue) => issue.status === "fail").length;
  const inventoryWarningCount = report.issueInventory.filter((issue) => issue.status === "warning").length;
  assert.equal(report.summary.failCount, inventoryFailCount);
  assert.equal(report.summary.warningCount, inventoryWarningCount);

  const stageEvents = job.history.filter((event) => event.type === "status").map((event) => event.payload.stage);
  assert.ok(stageEvents.includes("verifying_references"));
  assert.ok(stageEvents.indexOf("verifying_references") > stageEvents.indexOf("evaluating_references"));
  assert.ok(stageEvents.indexOf("verifying_references") < stageEvents.indexOf("llm_review"));

  const referencesSectionEvents = job.history.filter(
    (event) => event.type === "section" && event.payload.section.id === "references",
  );
  assert.equal(referencesSectionEvents.length, 2);
  assert.ok(
    referencesSectionEvents[1].payload.section.findings.some(
      (finding) => finding.title === "Unresolvable DOIs in references",
    ),
  );
});
