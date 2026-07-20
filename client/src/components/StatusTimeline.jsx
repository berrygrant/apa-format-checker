import { memo } from "react";
import { formatTimestamp } from "../lib/formatters.js";

export default memo(function StatusTimeline({ currentStage, history, progress, stages, idle = false }) {
  const currentIndex = stages.findIndex((stage) => stage.id === currentStage);
  const latestUpdate = history.at(-1);
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress || 0)));

  return (
    <section className="panel timeline-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Streaming Status</div>
          <h3>Review progress</h3>
        </div>
        {idle ? null : <strong className="progress-value">{clampedProgress}%</strong>}
      </div>

      <div
        aria-label="Review progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={idle ? 0 : clampedProgress}
        className="progress-track"
        role="progressbar"
      >
        <div className="progress-fill" style={{ width: `${idle ? 0 : clampedProgress}%` }} />
      </div>

      <div aria-live="polite" className="status-current">
        <strong>{idle ? "Ready — upload a document to begin." : latestUpdate?.message || "Waiting for the first review event."}</strong>
        {!idle && latestUpdate?.timestamp ? <span>{formatTimestamp(latestUpdate.timestamp)}</span> : null}
      </div>

      <div className="step-pills">
        {stages.map((stage, index) => {
          const isComplete = currentIndex > index || currentStage === "completed";
          const isActive = currentIndex === index && currentStage !== "completed";

          return (
            <span className={`step-pill ${isComplete ? "is-complete" : ""} ${isActive ? "is-active" : ""}`} key={stage.id}>
              {stage.label}
            </span>
          );
        })}
      </div>

      <div className="status-log compact">
        {(history.length === 0 ? [] : history.slice(-3).reverse()).map((item, index) => (
          <div className="status-log-row" key={`${item.stage}-${item.timestamp}-${index}`}>
            <strong>{item.message}</strong>
            <span>{formatTimestamp(item.timestamp)}</span>
          </div>
        ))}
      </div>
    </section>
  );
});
