import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import UploadPanel from "./components/UploadPanel.jsx";
import StatusTimeline from "./components/StatusTimeline.jsx";
import SectionCard from "./components/SectionCard.jsx";
import ReportSummary from "./components/ReportSummary.jsx";
import {
  UnauthorizedError,
  createReviewJob,
  getAuthSession,
  loginWithPassword,
  logoutSession,
  openReviewStream,
} from "./lib/api.js";
import { MAX_DOCX_BYTES, REVIEW_MODES, REVIEW_STAGES, SECTION_SLOTS } from "./lib/constants.js";

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
    return "Choose a .docx or .pdf file to begin.";
  }

  const filename = file.name.toLowerCase();

  if (!filename.endsWith(".docx") && !filename.endsWith(".pdf")) {
    return "Only .docx and .pdf uploads are supported.";
  }

  if (file.size > MAX_DOCX_BYTES) {
    return "The file exceeds the 3 MB limit.";
  }

  return "";
}

export default function App() {
  const eventSourceRef = useRef(null);
  const terminalEventRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState(null);
  const [reviewMode, setReviewMode] = useState(REVIEW_MODES[0].id);
  const [fileError, setFileError] = useState("");
  const [appError, setAppError] = useState("");
  const [jobId, setJobId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [jobStatus, setJobStatus] = useState("idle");
  const [streamState, setStreamState] = useState(EMPTY_STREAM_STATE);
  const [authState, setAuthState] = useState({
    enabled: false,
    authenticated: false,
    loading: true,
    password: "",
    error: "",
    isSubmitting: false,
  });

  const deferredSections = useDeferredValue(streamState.sections);
  const deferredReport = useDeferredValue(streamState.report);

  useEffect(() => {
    let isMounted = true;

    getAuthSession()
      .then((session) => {
        if (!isMounted) {
          return;
        }

        setAuthState((previous) => ({
          ...previous,
          enabled: Boolean(session.enabled),
          authenticated: Boolean(session.authenticated),
          loading: false,
          error: "",
        }));
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }

        setAuthState((previous) => ({
          ...previous,
          enabled: true,
          authenticated: false,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load the password gate.",
        }));
      });

    return () => {
      isMounted = false;
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
      const payload = await createReviewJob(fileToReview, reviewMode);
      setJobId(payload.jobId);
      connectToStream(payload.jobId);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        setAuthState((previous) => ({
          ...previous,
          enabled: true,
          authenticated: false,
          error: error.message,
        }));
        setAppError("");
        setJobStatus("idle");
        return;
      }

      setJobStatus("failed");
      setAppError(error instanceof Error ? error.message : "Unable to start the APA review.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();

    setAuthState((previous) => ({
      ...previous,
      isSubmitting: true,
      error: "",
    }));

    try {
      const session = await loginWithPassword(authState.password);
      setAuthState({
        enabled: Boolean(session.enabled),
        authenticated: true,
        loading: false,
        password: "",
        error: "",
        isSubmitting: false,
      });
    } catch (error) {
      setAuthState((previous) => ({
        ...previous,
        authenticated: false,
        error: error instanceof Error ? error.message : "Unable to verify the password.",
        isSubmitting: false,
      }));
    }
  }

  async function handleLogout() {
    resetStreamState();
    setSelectedFile(null);
    setFileError("");

    try {
      await logoutSession();
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Unable to sign out.");
    }

    setAuthState((previous) => ({
      ...previous,
      authenticated: false,
      password: "",
      error: "",
      isSubmitting: false,
    }));
  }

  const isGateVisible = authState.loading || (authState.enabled && !authState.authenticated);

  return (
    <div className="app-shell">
      <div className="background-orbit background-orbit-left" />
      <div className="background-orbit background-orbit-right" />

      <header className="hero">
        <div className="hero-topline">
          <div>
            <div className="eyebrow">Thesis APA Formatter</div>
            <h1>Automated APA 7 review with streamed hybrid validation.</h1>
            <p>
              Upload a thesis draft, stream the parser and rule engine, then merge the result with a structured OpenAI
              review that stays on the server.
            </p>
          </div>

          {authState.enabled && authState.authenticated ? (
            <button className="secondary-button hero-action" onClick={handleLogout} type="button">
              Sign Out
            </button>
          ) : null}
        </div>
        <div className="hero-contact">
          Questions? Contact <a href="mailto:grant.berry@villanova.edu">grant.berry@villanova.edu</a>
        </div>
      </header>

      {isGateVisible ? (
        <main className="auth-workspace">
          <section className="panel auth-panel">
            <div className="eyebrow">Protected Access</div>
            <h2>Enter the shared password to continue.</h2>
            <p className="panel-copy">
              This gate only activates on the protected hostname. Once the password is accepted, uploads and streamed
              review results use the same server-side session.
            </p>

            {authState.loading ? (
              <p className="auth-message">Checking access...</p>
            ) : (
              <form className="auth-form" onSubmit={handleLogin}>
                <label className="auth-field">
                  <span>Password</span>
                  <input
                    autoComplete="current-password"
                    onChange={(event) =>
                      setAuthState((previous) => ({
                        ...previous,
                        password: event.target.value,
                        error: "",
                      }))
                    }
                    type="password"
                    value={authState.password}
                  />
                </label>

                <button className="primary-button" disabled={authState.isSubmitting || !authState.password.trim()} type="submit">
                  {authState.isSubmitting ? "Checking..." : "Unlock App"}
                </button>
              </form>
            )}

            {authState.error ? <p className="app-error">{authState.error}</p> : null}
          </section>
        </main>
      ) : (
        <main className="workspace">
          <UploadPanel
            error={fileError}
            file={selectedFile}
            isBusy={isSubmitting || jobStatus === "processing"}
            jobId={jobId}
            onFilePicked={handleFilePicked}
            onReviewModeChange={setReviewMode}
            onRun={handleRun}
            reviewMode={reviewMode}
            reviewModes={REVIEW_MODES}
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
      )}
    </div>
  );
}
