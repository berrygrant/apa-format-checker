import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import UploadPanel from "./components/UploadPanel.jsx";
import StatusTimeline from "./components/StatusTimeline.jsx";
import SectionCard from "./components/SectionCard.jsx";
import ReportSummary from "./components/ReportSummary.jsx";
import { createReviewJob, openReviewStream } from "./lib/api.js";
import { MAX_DOCX_BYTES, REVIEW_STAGES, SECTION_SLOTS } from "./lib/constants.js";

const EMPTY_STREAM_STATE = {
  currentStage: "idle",
  progress: 0,
  statusHistory: [],
  sections: {},
  report: null,
  llmPreview: "",
  error: "",
};

function fileValidationError(file) {
  if (!file) {
    return "Choose a .docx file to begin.";
  }

  if (!file.name.toLowerCase().endsWith(".docx")) {
    return "Only .docx uploads are supported.";
  }

  if (file.size > MAX_DOCX_BYTES) {
    return "The document exceeds the 3 MB limit.";
  }

  return "";
}

export default function App() {
  const eventSourceRef = useRef(null);
  const terminalEventRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState(null);
  const [fileError, setFileError] = useState("");
  const [appError, setAppError] = useState("");
  const [jobId, setJobId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [jobStatus, setJobStatus] = useState("idle");
  const [streamState, setStreamState] = useState(EMPTY_STREAM_STATE);

  const deferredSections = useDeferredValue(streamState.sections);
  const deferredReport = useDeferredValue(streamState.report);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  function closeStream() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }

  function resetStreamState() {
    terminalEventRef.current = false;
    closeStream();
    setStreamState(EMPTY_STREAM_STATE);
    setAppError("");
    setJobStatus("idle");
    setJobId("");
  }

  function handleFilePicked(file) {
    const validationError = fileValidationError(file);

    if (validationError) {
      setSelectedFile(null);
      setFileError(validationError);
      return;
    }

    setSelectedFile(file);
    setFileError("");
    setAppError("");
  }

  function applySnapshot(snapshot) {
    setJobStatus(snapshot.status);
    setAppError(snapshot.error?.message || "");
    setStreamState({
      currentStage: snapshot.currentStage || "queued",
      progress:
        (snapshot.history || [])
          .filter((event) => event.type === "status")
          .map((event) => event.payload?.progress)
          .filter((value) => Number.isFinite(value))
          .at(-1) ?? 0,
      statusHistory: (snapshot.history || [])
        .filter((event) => event.type === "status")
        .map((event) => event.payload),
      sections: Object.fromEntries((snapshot.sections || []).map((section) => [section.id, section])),
      report: snapshot.report || null,
      llmPreview: snapshot.llmPreview || "",
      error: snapshot.error?.message || "",
    });

    if (snapshot.status === "completed" || snapshot.status === "failed") {
      terminalEventRef.current = true;
    }
  }

  function connectToStream(nextJobId) {
    closeStream();

    const source = openReviewStream(nextJobId, {
      onSnapshot: (snapshot) => {
        startTransition(() => {
          applySnapshot(snapshot);
        });
      },
      onStatus: (payload) => {
        startTransition(() => {
          setJobStatus(payload.stage === "completed" ? "completed" : "processing");
          setStreamState((previous) => ({
            ...previous,
            currentStage: payload.stage,
            progress: Number.isFinite(payload.progress) ? payload.progress : previous.progress,
            statusHistory: [...previous.statusHistory, payload].slice(-20),
          }));
        });
      },
      onSection: ({ section }) => {
        startTransition(() => {
          setStreamState((previous) => ({
            ...previous,
            sections: {
              ...previous.sections,
              [section.id]: section,
            },
          }));
        });
      },
      onLlmDelta: ({ llmPreview }) => {
        startTransition(() => {
          setStreamState((previous) => ({
            ...previous,
            llmPreview,
          }));
        });
      },
      onComplete: ({ report }) => {
        terminalEventRef.current = true;
        startTransition(() => {
          setJobStatus("completed");
          setStreamState((previous) => ({
            ...previous,
            currentStage: "completed",
            report,
          }));
        });
        closeStream();
      },
      onErrorEvent: ({ error }) => {
        terminalEventRef.current = true;
        startTransition(() => {
          setJobStatus("failed");
          setAppError(error?.message || "Review failed.");
          setStreamState((previous) => ({
            ...previous,
            currentStage: "failed",
            error: error?.message || "Review failed.",
          }));
        });
        closeStream();
      },
      onConnectionError: (readyState) => {
        if (terminalEventRef.current || readyState !== 2) {
          return;
        }

        startTransition(() => {
          setAppError("The SSE connection closed before the review finished.");
        });
      },
    });

    eventSourceRef.current = source;
  }

  async function handleRun() {
    const fileToReview = selectedFile;
    const validationError = fileValidationError(fileToReview);

    if (validationError) {
      setFileError(validationError);
      return;
    }

    resetStreamState();
    setSelectedFile(fileToReview);
    setIsSubmitting(true);
    setJobStatus("processing");
    setStreamState({
      ...EMPTY_STREAM_STATE,
      currentStage: "queued",
      progress: 2,
    });

    try {
      const payload = await createReviewJob(fileToReview);
      setJobId(payload.jobId);
      connectToStream(payload.jobId);
    } catch (error) {
      setJobStatus("failed");
      setAppError(error instanceof Error ? error.message : "Unable to start the APA review.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="background-orbit background-orbit-left" />
      <div className="background-orbit background-orbit-right" />

      <header className="hero">
        <div className="eyebrow">Thesis APA Formatter</div>
        <h1>Automated APA 7 review with streamed hybrid validation.</h1>
        <p>
          Upload a thesis draft, stream the parser and rule engine, then merge the result with a structured OpenAI
          review that stays on the server.
        </p>
      </header>

      <main className="workspace">
        <UploadPanel
          error={fileError}
          file={selectedFile}
          isBusy={isSubmitting || jobStatus === "processing"}
          jobId={jobId}
          onFilePicked={handleFilePicked}
          onRun={handleRun}
        />

        <div className="results-column">
          <StatusTimeline
            currentStage={streamState.currentStage}
            history={streamState.statusHistory}
            progress={streamState.progress}
            stages={REVIEW_STAGES}
          />

          <section className="panel sections-panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Section Updates</div>
                <h3>Live APA review sections</h3>
              </div>
            </div>

            <div className="sections-grid">
              {SECTION_SLOTS.map((slot) => (
                <SectionCard fallbackLabel={slot.label} key={slot.id} section={deferredSections[slot.id]} sectionId={slot.id} />
              ))}
            </div>
          </section>

          {streamState.llmPreview ? (
            <details className="panel llm-panel">
              <summary>LLM stream preview</summary>
              <pre>{streamState.llmPreview}</pre>
            </details>
          ) : null}

          {deferredReport ? (
            <>
              <ReportSummary report={deferredReport} />

              <details className="panel json-panel">
                <summary>Raw APA compliance JSON</summary>
                <pre>{JSON.stringify(deferredReport, null, 2)}</pre>
              </details>
            </>
          ) : (
            <section className="panel report-placeholder-panel">
              <div className="eyebrow">Final Output</div>
              <h3>Structured APA compliance JSON</h3>
              <p>
                The final report will appear here after the rule-based checks and OpenAI stage complete.
              </p>
            </section>
          )}

          {appError ? <p className="app-error">{appError}</p> : null}
        </div>
      </main>
    </div>
  );
}
