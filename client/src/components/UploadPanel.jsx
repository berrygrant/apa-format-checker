import { memo, useId, useState } from "react";
import { SUPPORTED_FILE_LABEL } from "../lib/constants.js";
import { formatBytes } from "../lib/formatters.js";

export default memo(function UploadPanel({
  file,
  error,
  isBusy,
  jobId,
  onFilePicked,
  onReviewModeChange,
  onRun,
  reviewMode,
  reviewModes,
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputId = useId();
  const selectedReviewMode = reviewModes.find((mode) => mode.id === reviewMode) ?? reviewModes[0];

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);

    const droppedFile = event.dataTransfer.files?.[0];
    if (droppedFile) {
      onFilePicked(droppedFile);
    }
  }

  function handleModeKeyDown(event, index) {
    const isNext = event.key === "ArrowRight" || event.key === "ArrowDown";
    const isPrevious = event.key === "ArrowLeft" || event.key === "ArrowUp";

    if (!isNext && !isPrevious) {
      return;
    }

    event.preventDefault();
    const offset = isNext ? 1 : -1;
    const nextIndex = (index + offset + reviewModes.length) % reviewModes.length;
    onReviewModeChange(reviewModes[nextIndex].id);
    event.currentTarget.parentElement?.children[nextIndex]?.focus();
  }

  return (
    <section className="panel upload-panel">
      <div className="eyebrow">Upload</div>
      <h2>Upload your Thesis</h2>
      <p className="panel-copy">
        Drag in a Word document or PDF, then stream parser progress, rule-based checks, and the structured OpenAI review.
      </p>
      <div aria-label="Review mode" className="review-mode-field" role="radiogroup">
        <span className="review-mode-label">Review mode</span>
        <div className="review-mode-options">
          {reviewModes.map((mode, index) => (
            <button
              aria-checked={reviewMode === mode.id}
              className={`review-mode-button ${reviewMode === mode.id ? "is-selected" : ""}`}
              disabled={isBusy}
              key={mode.id}
              onClick={() => onReviewModeChange(mode.id)}
              onKeyDown={(event) => handleModeKeyDown(event, index)}
              role="radio"
              tabIndex={reviewMode === mode.id ? 0 : -1}
              type="button"
            >
              {mode.label}
            </button>
          ))}
        </div>
        <p className="review-mode-hint">{selectedReviewMode.description}</p>
      </div>

      <label
        className={`dropzone ${isDragging ? "is-dragging" : ""}`}
        htmlFor={inputId}
        onDragEnter={() => setIsDragging(true)}
        onDragLeave={() => setIsDragging(false)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <input
          id={inputId}
          type="file"
          hidden
          accept=".docx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
          onChange={(event) => {
            const nextFile = event.target.files?.[0];
            if (nextFile) {
              onFilePicked(nextFile);
            }
          }}
        />
        <span className="dropzone-badge">{SUPPORTED_FILE_LABEL}</span>
        <strong>{file ? file.name : "Drop a thesis document here"}</strong>
        <span>{file ? formatBytes(file.size) : "Maximum file size: 3 MB"}</span>
      </label>

      <div className="upload-actions">
        <label className="secondary-button" htmlFor={inputId}>
          Choose file
        </label>
        <button className="primary-button" disabled={!file || isBusy} onClick={onRun} type="button">
          {isBusy ? "Running APA Check..." : "Run APA Check"}
        </button>
      </div>

      <p className="disclaimer-note">
        Submitted content may be shared with OpenAI during the review process. Do not upload sensitive or confidential data
        unless that is acceptable for your use case.
      </p>

      <p className="limitations-note">
        Layout settings (margins, font, line spacing, indentation, page numbers) are measured from the stored settings
        of DOCX uploads. They cannot be verified from PDFs, and per-page details like widows or exact placement still
        need a manual check.
      </p>

      {jobId ? (
        <div className="job-chip">
          <span>Job</span>
          <code>{jobId}</code>
        </div>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
});
