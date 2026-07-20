import { memo } from "react";
import { formatTimestamp } from "../lib/formatters.js";

export default memo(function StatusTimeline({ currentStage, history, progress, stages }) {
  const currentIndex = stages.findIndex((stage) => stage.id === currentStage);
  const latestUpdate = history.at(-1);

  return (
    <section className="panel timeline-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Streaming Status</div>
          <h3>Review progress</h3>
        </div>
        <strong className="progress-value">{Math.max(0, Math.min(100, Math.round(progress || 0)))}%</strong>
      </div>

      <div className="progress-track" aria-label="Review progress">
        <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, progress || 0))}%` }} />
      </div>

      <div className="status-current">
        <strong>{latestUpdate?.message || "Waiting for the first review event."}</strong>
        {latestUpdate?.timestamp ? <span>{formatTimestamp(latestUpdate.timestamp)}</span> : null}
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
