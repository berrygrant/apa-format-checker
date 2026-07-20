import { memo } from "react";

export default memo(function LlmActivityIndicator({ charactersReceived }) {
  return (
    <section aria-live="polite" className="panel llm-activity-panel">
      <div className="llm-activity-row">
        <span aria-hidden="true" className="llm-activity-dots">
          <span />
          <span />
          <span />
        </span>
        <div>
          <strong>AI review in progress</strong>
          <p>
            The structured OpenAI review is streaming back — {charactersReceived.toLocaleString()} characters received so
            far. Findings appear in the OpenAI Review section when the pass completes.
          </p>
        </div>
      </div>
    </section>
  );
});
