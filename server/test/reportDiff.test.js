import assert from "node:assert/strict";
import test from "node:test";

// Pure ESM module shared with the client; imported directly so the diff logic
// stays covered by the server suite.
import { diffInventories, excerptPrefix, issueIdentity, summarizeDiff } from "../../client/src/lib/reportDiff.js";

function ruleIssue({
  sectionId = "citations",
  title = "In-text citation format",
  status = "warning",
  lineStart = 42,
  excerpt = "Prior work suggests that formative feedback is most useful when it is specific (Smith 2022).",
} = {}) {
  return {
    source: "rule_based",
    sectionId,
    sectionLabel: "Citations",
    status,
    title,
    detail: "Detail text.",
    recommendation: "Fix it.",
    evidence: excerpt || null,
    location: {
      sectionId,
      lineStart,
      lineEnd: lineStart,
      label: `Body line ${lineStart}`,
      excerpt,
    },
  };
}

test("identity is stable when a fix elsewhere shifts the line number", () => {
  const before = ruleIssue({ lineStart: 42 });
  const after = ruleIssue({ lineStart: 57 });

  assert.equal(issueIdentity(before), issueIdentity(after));
});

test("identity is stable across entry-number shifts embedded in titles and labels", () => {
  const before = {
    sectionId: "references",
    title: "Reference entry 3 is out of order",
    status: "warning",
    location: { label: "References entry 3 (line 120)", excerpt: "Walker, M. (2017). Why we sleep. Scribner." },
  };
  const after = {
    sectionId: "references",
    title: "Reference entry 4 is out of order",
    status: "warning",
    location: { label: "References entry 4 (line 131)", excerpt: "Walker, M. (2017). Why we sleep. Scribner." },
  };

  assert.equal(issueIdentity(before), issueIdentity(after));
});

test("same title in the same section stays distinct through the excerpt prefix", () => {
  const first = ruleIssue({ excerpt: "First offending sentence with its own wording here." });
  const second = ruleIssue({ excerpt: "Second offending sentence that reads completely differently." });

  assert.notEqual(issueIdentity(first), issueIdentity(second));
});

test("identity matches between a full inventory issue and its minimal stored shape", () => {
  const fullIssue = ruleIssue({});
  const storedIssue = {
    sectionId: fullIssue.sectionId,
    title: fullIssue.title,
    status: fullIssue.status,
    locationLabel: fullIssue.location.label,
    excerptPrefix: excerptPrefix(fullIssue.location.excerpt),
  };

  assert.equal(issueIdentity(fullIssue), issueIdentity(storedIssue));
});

test("an issue without an excerpt falls back to the digit-stripped location label", () => {
  const before = ruleIssue({ excerpt: "", lineStart: 12 });
  const after = ruleIssue({ excerpt: "", lineStart: 19 });

  assert.equal(issueIdentity(before), issueIdentity(after));
  assert.ok(issueIdentity(before).endsWith("|body line"));
});

test("diffInventories partitions resolved, added, and persisting issues", () => {
  const missingCitation = ruleIssue({ title: "Citation missing from reference list", excerpt: "(Nguyen, 2018)" });
  const doubleSpacing = ruleIssue({ sectionId: "layout", title: "Line spacing", excerpt: "Spacing measured at 1.5" });
  const hangingIndent = ruleIssue({
    sectionId: "references",
    title: "Hanging indent",
    excerpt: "Walker, M. (2017). Why we sleep.",
    lineStart: 88,
  });

  const previousIssues = [missingCitation, doubleSpacing, hangingIndent];
  const currentIssues = [
    // Same spacing issue, shifted lines after edits above it.
    ruleIssue({ sectionId: "layout", title: "Line spacing", excerpt: "Spacing measured at 1.5", lineStart: 51 }),
    ruleIssue({ sectionId: "references", title: "Hanging indent", excerpt: "Walker, M. (2017). Why we sleep.", lineStart: 97 }),
    ruleIssue({ sectionId: "body", title: "Heading level skipped", excerpt: "Methods subsection starts at level 3" }),
  ];

  const diff = diffInventories(previousIssues, currentIssues);

  assert.deepEqual(
    diff.resolved.map((issue) => issue.title),
    ["Citation missing from reference list"],
  );
  assert.deepEqual(
    diff.added.map((issue) => issue.title),
    ["Heading level skipped"],
  );
  assert.deepEqual(
    diff.persisting.map((issue) => issue.title),
    ["Line spacing", "Hanging indent"],
  );
});

test("diffInventories ignores pass findings and tolerates missing arrays", () => {
  const passFinding = ruleIssue({ title: "Margins", status: "pass" });
  const warning = ruleIssue({ title: "Line spacing", status: "warning" });
  const info = ruleIssue({ title: "Page numbers", status: "info", excerpt: "Field code present" });

  const diff = diffInventories([passFinding, warning], [warning, info, passFinding]);

  assert.equal(diff.resolved.length, 0);
  assert.deepEqual(
    diff.added.map((issue) => issue.title),
    ["Page numbers"],
  );
  assert.deepEqual(
    diff.persisting.map((issue) => issue.title),
    ["Line spacing"],
  );

  const emptyDiff = diffInventories(undefined, null);
  assert.deepEqual(emptyDiff, { resolved: [], added: [], persisting: [] });
});

test("summarizeDiff wording covers fixed, none-fixed, singular, and clean runs", () => {
  const issue = (title) => ruleIssue({ title, excerpt: title });

  assert.equal(
    summarizeDiff({
      resolved: [issue("a"), issue("b"), issue("c"), issue("d")],
      added: [issue("e"), issue("f")],
      persisting: Array.from({ length: 9 }, (_, index) => issue(`p${index}`)),
    }),
    "Fixed 4 issues since your last run — 2 new, 9 remaining",
  );

  assert.equal(
    summarizeDiff({ resolved: [issue("a")], added: [], persisting: [] }),
    "Fixed 1 issue since your last run — 0 new, 0 remaining",
  );

  assert.equal(
    summarizeDiff({ resolved: [], added: [issue("a")], persisting: [issue("b")] }),
    "No issues fixed since your last run — 1 new, 1 remaining",
  );

  assert.equal(summarizeDiff({ resolved: [], added: [], persisting: [] }), "No issues in this run or your last run");
});
