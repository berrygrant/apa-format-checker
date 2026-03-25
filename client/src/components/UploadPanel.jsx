import { useId, useState } from "react";
import { formatBytes } from "../lib/formatters.js";

export default function UploadPanel({ file, error, isBusy, jobId, onFilePicked, onRun }) {
  const [isDragging, setIsDragging] = useState(false);
  const inputId = useId();

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);

    const droppedFile = event.dataTransfer.files?.[0];
    if (droppedFile) {
      onFilePicked(droppedFile);
    }
  }

  return (
    <section className="panel upload-panel">
      <div className="eyebrow">Upload</div>
      <h2>Run an APA 7 thesis review from a DOCX upload.</h2>
      <p className="panel-copy">
        Drag in a Word document, then stream parser progress, rule-based checks, and the structured OpenAI review.
      </p>

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
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(event) => {
            const nextFile = event.target.files?.[0];
            if (nextFile) {
              onFilePicked(nextFile);
            }
          }}
        />
        <span className="dropzone-badge">DOCX only</span>
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

      {jobId ? (
        <div className="job-chip">
          <span>Job</span>
          <code>{jobId}</code>
        </div>
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

