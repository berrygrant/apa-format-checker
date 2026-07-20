import { memo, useMemo, useState } from "react";
import { humanizeStatus } from "../lib/formatters.js";

const SEVERITY_FILTERS = [
  { id: "all", label: "All" },
  { id: "fail", label: "Failures" },
  { id: "warning", label: "Warnings" },
  { id: "info", label: "Info" },
];

function sourceBadge(issue) {
  if (issue.alsoFlaggedByLlm) {
    return "Rule + AI";
  }

  return issue.source === "llm" ? "AI review" : "Rule check";
}

function formatIssueForClipboard(issue) {
  return [
    `${humanizeStatus(issue.status)}: ${issue.title}`,
    issue.location?.label ? `Where: ${issue.location.label}` : null,
    issue.detail ? `Problem: ${issue.detail}` : null,
    issue.recommendation ? `Fix: ${issue.recommendation}` : null,
    issue.evidence ? `Excerpt: ${issue.evidence}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function IssueCard({ issue }) {
  const [copyState, setCopyState] = useState("idle");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatIssueForClipboard(issue));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <article className="issue-card">
      <div className="issue-card-header">
        <span className={`status-pill ${issue.status}`}>{humanizeStatus(issue.status)}</span>
        <span className="issue-source-badge">{sourceBadge(issue)}</span>
        <button className="issue-copy-button" onClick={handleCopy} type="button">
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>

      <strong className="issue-title">{issue.title}</strong>
      {issue.location?.label ? <p className="issue-location">Where: {issue.location.label}</p> : null}
      {issue.detail ? <p className="issue-detail">{issue.detail}</p> : null}
      {issue.recommendation ? <p className="issue-recommendation">Fix: {issue.recommendation}</p> : null}

      {issue.evidence ? (
        <details className="issue-evidence">
          <summary>Source excerpt</summary>
          <p>{issue.evidence}</p>
        </details>
      ) : null}
    </article>
  );
}

export default memo(function IssueInventoryPanel({ report }) {
  const [severityFilter, setSeverityFilter] = useState("all");
  const [sectionFilter, setSectionFilter] = useState("all");

  const issues = useMemo(
    () => (report.issueInventory ?? []).filter((issue) => issue.status !== "pass"),
    [report],
  );

  const severityCounts = useMemo(() => {
    const counts = { all: issues.length, fail: 0, warning: 0, info: 0 };

    for (const issue of issues) {
      if (counts[issue.status] !== undefined) {
        counts[issue.status] += 1;
      }
    }

    return counts;
  }, [issues]);

  const sections = useMemo(() => {
    const seen = new Map();

    for (const issue of issues) {
      if (!seen.has(issue.sectionId)) {
        seen.set(issue.sectionId, issue.sectionLabel || issue.sectionId);
      }
    }

    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [issues]);

  const visibleIssues = useMemo(
    () =>
      issues.filter(
        (issue) =>
          (severityFilter === "all" || issue.status === severityFilter) &&
          (sectionFilter === "all" || issue.sectionId === sectionFilter),
      ),
    [issues, severityFilter, sectionFilter],
  );

  if (issues.length === 0) {
    return (
      <section className="panel issues-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">All Issues</div>
            <h3>Item-level findings</h3>
          </div>
        </div>
        <p className="issues-empty">No item-level issues were detected. Review the section cards above for the passing checks.</p>
      </section>
    );
  }

  return (
    <section className="panel issues-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">All Issues</div>
          <h3>Item-level findings</h3>
        </div>
        <span className="issues-count">{visibleIssues.length} shown</span>
      </div>

      <p className="panel-copy">
        Every rule-based and AI-detected issue with its best-effort location. Use the excerpt with your editor's Find
        (Ctrl/Cmd+F) to jump to the spot in your document.
      </p>

      <div className="issues-controls">
        <div aria-label="Filter by severity" className="issues-filter-chips" role="group">
          {SEVERITY_FILTERS.map((filter) => (
            <button
              aria-pressed={severityFilter === filter.id}
              className={`issues-filter-chip ${severityFilter === filter.id ? "is-selected" : ""}`}
              key={filter.id}
              onClick={() => setSeverityFilter(filter.id)}
              type="button"
            >
              {filter.label} ({severityCounts[filter.id] ?? 0})
            </button>
          ))}
        </div>

        {sections.length > 1 ? (
          <label className="issues-section-filter">
            <span>Section</span>
            <select onChange={(event) => setSectionFilter(event.target.value)} value={sectionFilter}>
              <option value="all">All sections</option>
              {sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="issues-list">
        {visibleIssues.map((issue) => (
          <IssueCard issue={issue} key={issue.id ?? `${issue.sectionId}-${issue.title}-${issue.location?.label ?? ""}`} />
        ))}
        {visibleIssues.length === 0 ? <p className="issues-empty">No issues match the current filters.</p> : null}
      </div>
    </section>
  );
});
