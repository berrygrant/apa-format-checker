import { memo, useEffect, useMemo, useState } from "react";
import { UnauthorizedError, getCohortInsights } from "../lib/api.js";
import { humanizeStatus } from "../lib/formatters.js";

const WINDOW_OPTIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const TOP_CHECK_LIMIT = 10;

function dominantSeverity(severityTally = {}) {
  const fail = severityTally.fail ?? 0;
  const warning = severityTally.warning ?? 0;
  const info = severityTally.info ?? 0;

  if (fail > 0 && fail >= warning && fail >= info) {
    return "fail";
  }

  if (warning > 0 && warning >= info) {
    return "warning";
  }

  return "info";
}

function CheckRow({ check, totalRuns }) {
  const severity = dominantSeverity(check.severityTally);
  const barWidth = Math.min(100, Math.max(check.percentOfRuns, 2));

  return (
    <li className="insights-check-row">
      <div className="insights-check-top">
        <span className={`status-pill ${severity}`}>{humanizeStatus(severity)}</span>
        <strong className="insights-check-title">{check.title}</strong>
        <span className="insights-check-percent">{check.percentOfRuns}%</span>
      </div>
      <div
        aria-label={`${check.percentOfRuns}% of runs affected`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={check.percentOfRuns}
        className="insights-bar-track"
        role="meter"
      >
        <div className={`insights-bar-fill ${severity}`} style={{ width: `${barWidth}%` }} />
      </div>
      <span className="insights-check-meta">
        {check.runsAffected} of {totalRuns} run{totalRuns === 1 ? "" : "s"} · {check.occurrences} occurrence
        {check.occurrences === 1 ? "" : "s"} · {check.sectionId} section
      </span>
    </li>
  );
}

export default memo(function InsightsPanel({ onUnauthorized }) {
  const [days, setDays] = useState(30);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [insights, setInsights] = useState(null);

  useEffect(() => {
    let isActive = true;

    setIsLoading(true);
    setLoadError("");

    getCohortInsights(days)
      .then((snapshot) => {
        if (isActive) {
          setInsights(snapshot);
        }
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }

        if (error instanceof UnauthorizedError) {
          onUnauthorized?.(error);
          return;
        }

        setLoadError(error instanceof Error ? error.message : "Unable to load cohort insights.");
      })
      .finally(() => {
        if (isActive) {
          setIsLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [days, refreshToken, onUnauthorized]);

  const topChecks = useMemo(() => (insights?.topChecks ?? []).slice(0, TOP_CHECK_LIMIT), [insights]);
  const hasRuns = Boolean(insights && insights.totalRuns > 0);

  return (
    <section className="panel insights-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Instructor Analytics</div>
          <h3>Cohort insights</h3>
        </div>

        <div aria-label="Aggregation window" className="insights-window-chips" role="group">
          {WINDOW_OPTIONS.map((option) => (
            <button
              aria-pressed={days === option.days}
              className={`insights-window-chip ${days === option.days ? "is-selected" : ""}`}
              disabled={isLoading}
              key={option.days}
              onClick={() => setDays(option.days)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p aria-busy="true" className="insights-status">
          Loading cohort insights...
        </p>
      ) : loadError ? (
        <div className="insights-error">
          <p className="app-error" role="alert">
            {loadError}
          </p>
          <button className="secondary-button" onClick={() => setRefreshToken((token) => token + 1)} type="button">
            Retry
          </button>
        </div>
      ) : !hasRuns ? (
        <p className="insights-status">
          No completed reviews in the last {insights?.windowDays ?? days} days yet. Aggregates appear here after the
          first review finishes.
        </p>
      ) : (
        <>
          <div className="summary-grid">
            <div className="summary-card">
              <span>Runs in window</span>
              <strong>{insights.totalRuns}</strong>
              <span className="summary-card-note">last {insights.windowDays} days</span>
            </div>
            <div className="summary-card">
              <span>Runs with a failure</span>
              <strong>{insights.runsWithAnyFailPercent}%</strong>
            </div>
            <div className="summary-card">
              <span>DOCX / PDF</span>
              <strong>
                {insights.bySourceFormat.docx} / {insights.bySourceFormat.pdf}
              </strong>
            </div>
            <div className="summary-card">
              <span>Standard / Comprehensive</span>
              <strong>
                {insights.byMode.standard} / {insights.byMode.comprehensive}
              </strong>
            </div>
          </div>

          {topChecks.length > 0 ? (
            <div className="insights-checks">
              <h4>Most common problem checks</h4>
              <ol className="insights-check-list">
                {topChecks.map((check) => (
                  <CheckRow check={check} key={check.key} totalRuns={insights.totalRuns} />
                ))}
              </ol>
            </div>
          ) : (
            <p className="insights-status">Reviews ran in this window, but no issue-level checks were recorded.</p>
          )}
        </>
      )}

      <p className="insights-privacy-note">Aggregated counts only — no documents or names are stored.</p>
    </section>
  );
});
