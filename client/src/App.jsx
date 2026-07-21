import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import UploadPanel from "./components/UploadPanel.jsx";
import StatusTimeline from "./components/StatusTimeline.jsx";
import SectionCard from "./components/SectionCard.jsx";
import ReportSummary from "./components/ReportSummary.jsx";
import LlmActivityIndicator from "./components/LlmActivityIndicator.jsx";
import IssueInventoryPanel from "./components/IssueInventoryPanel.jsx";
import InsightsPanel from "./components/InsightsPanel.jsx";
import {
  UnauthorizedError,
  getAuthSession,
  loginWithPassword,
  logoutSession,
  runReviewStream,
} from "./lib/api.js";
import { MAX_UPLOAD_BYTES, REVIEW_MODES, REVIEW_STAGES, SECTION_SLOTS, SUPPORTED_EXTENSIONS } from "./lib/constants.js";
import { diffInventories, issueIdentity } from "./lib/reportDiff.js";
import { loadPreviousRun, saveRun, toStoredIssues } from "./lib/reviewHistory.js";

const EMPTY_STREAM_STATE = {
  currentStage: "idle",
  progress: 0,
  statusHistory: [],
  sections: {},
  report: null,
  llmPreviewLength: 0,
  error: "",
};

// Compares the fresh report against the previous stored run for the same
// filename, then saves the fresh run as the new baseline. Returns null on the
// first run for a filename (nothing to compare against).
function computeRunDiff(report) {
  const filename = report?.document?.filename;

  if (!filename) {
    return null;
  }

  const previousRun = loadPreviousRun(filename);
  const currentIssues = report.issueInventory ?? [];
  const diff = previousRun ? diffInventories(previousRun.issues, currentIssues) : null;

  saveRun(filename, {
    timestamp: report.generatedAt ?? new Date().toISOString(),
    issues: toStoredIssues(currentIssues),
  });

  return diff;
}

function fileValidationError(file) {
  if (!file) {
    return "Choose a .docx or .pdf file to begin.";
  }

  const filename = file.name.toLowerCase();

  if (!SUPPORTED_EXTENSIONS.some((extension) => filename.endsWith(extension))) {
    return "Only .docx and .pdf uploads are supported.";
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return "The file exceeds the 3 MB limit.";
  }

  return "";
}

export default function App() {
  const abortControllerRef = useRef(null);
  const terminalEventRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState(null);
  const [reviewMode, setReviewMode] = useState(REVIEW_MODES[0].id);
  const [fileError, setFileError] = useState("");
  const [appError, setAppError] = useState("");
  const [jobId, setJobId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [jobStatus, setJobStatus] = useState("idle");
  const [streamState, setStreamState] = useState(EMPTY_STREAM_STATE);
  const [showInsights, setShowInsights] = useState(false);
  const [runDiff, setRunDiff] = useState(null);
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

  const addedIdentities = useMemo(
    () => (runDiff ? new Set(runDiff.added.map((issue) => issueIdentity(issue))) : null),
    [runDiff],
  );

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
      abortControllerRef.current?.abort();
    };
  }, []);

  const closeStream = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const resetStreamState = useCallback(() => {
    terminalEventRef.current = false;
    closeStream();
    setStreamState(EMPTY_STREAM_STATE);
    setRunDiff(null);
    setAppError("");
    setJobStatus("idle");
    setJobId("");
  }, [closeStream]);

  const handleFilePicked = useCallback((file) => {
    const validationError = fileValidationError(file);

    if (validationError) {
      setSelectedFile(null);
      setFileError(validationError);
      return;
    }

    setSelectedFile(file);
    setFileError("");
    setAppError("");
  }, []);

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
      llmPreviewLength: snapshot.llmPreview?.length ?? 0,
      error: snapshot.error?.message || "",
    });

    if (snapshot.status === "completed" || snapshot.status === "failed") {
      terminalEventRef.current = true;
    }
  }

  const streamReview = useCallback(async (fileToReview, controller) => {
    closeStream();
    abortControllerRef.current = controller;

    try {
      await runReviewStream(fileToReview, reviewMode, {
        onSnapshot: (snapshot) => {
          startTransition(() => {
            setJobId(snapshot.jobId || "");
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
        onLlmDelta: ({ delta, previewLength }) => {
          startTransition(() => {
            setStreamState((previous) => ({
              ...previous,
              llmPreviewLength: Number.isFinite(previewLength)
                ? previewLength
                : previous.llmPreviewLength + (delta?.length ?? 0),
            }));
          });
        },
        onComplete: ({ report }) => {
          terminalEventRef.current = true;
          // Diff against the previous stored run before saving this one.
          const diff = computeRunDiff(report);
          startTransition(() => {
            setJobStatus("completed");
            setRunDiff(diff);
            setStreamState((previous) => ({
              ...previous,
              currentStage: "completed",
              report,
            }));
          });
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
        },
      }, { signal: controller.signal });
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [closeStream, reviewMode]);

  const handleRun = useCallback(async () => {
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
      const controller = new AbortController();
      await streamReview(fileToReview, controller);

      if (!terminalEventRef.current) {
        setAppError("The review stream closed before the review finished.");
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }

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
  }, [resetStreamState, selectedFile, streamReview]);

  const handleInsightsUnauthorized = useCallback((error) => {
    setShowInsights(false);
    setAuthState((previous) => ({
      ...previous,
      enabled: true,
      authenticated: false,
      error: error instanceof Error ? error.message : "Password authentication is required.",
    }));
  }, []);

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
    setShowInsights(false);

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

  const isGateVisible = !authState.loading && authState.enabled && !authState.authenticated;
  const isIdle = jobStatus === "idle" && !streamState.report && streamState.statusHistory.length === 0;

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
            <div className="hero-actions">
              <button
                aria-pressed={showInsights}
                className={`secondary-button hero-action ${showInsights ? "is-active" : ""}`}
                onClick={() => setShowInsights((previous) => !previous)}
                type="button"
              >
                Cohort insights
              </button>
              <button className="secondary-button hero-action" onClick={handleLogout} type="button">
                Sign Out
              </button>
            </div>
          ) : null}
        </div>
        <div className="hero-contact">
          Questions? Contact <a href="mailto:grant.berry@villanova.edu">grant.berry@villanova.edu</a>
        </div>
      </header>

      {authState.loading ? (
        <main className="auth-workspace">
          <section aria-busy="true" className="panel auth-panel">
            <div className="eyebrow">Thesis APA Formatter</div>
            <p className="auth-message">Loading the review workspace...</p>
          </section>
        </main>
      ) : isGateVisible ? (
        <main className="auth-workspace">
          <section className="panel auth-panel">
            <div className="eyebrow">Protected Access</div>
            <h2>Enter the shared password to continue.</h2>
            <p className="panel-copy">
              This gate only activates on the protected hostname. Once the password is accepted, uploads and streamed
              review results use the same server-side session.
            </p>

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

            {authState.error ? (
              <p className="app-error" role="alert">
                {authState.error}
              </p>
            ) : null}
          </section>
        </main>
      ) : (
        <main className="workspace">
          {authState.enabled && authState.authenticated && showInsights ? (
            <div className="insights-region">
              <InsightsPanel onUnauthorized={handleInsightsUnauthorized} />
            </div>
          ) : null}

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
              idle={isIdle}
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

              {isIdle ? (
                <div className="sections-empty-state">
                  <p>
                    Once you run a review, each APA area — parsing, layout, title page, body, citations, references, and
                    the AI pass — streams into its own card here.
                  </p>
                </div>
              ) : (
                <div className="sections-grid">
                  {SECTION_SLOTS.map((slot) => (
                    <SectionCard fallbackLabel={slot.label} key={slot.id} section={deferredSections[slot.id]} sectionId={slot.id} />
                  ))}
                </div>
              )}
            </section>

            {streamState.currentStage === "llm_review" && streamState.llmPreviewLength > 0 ? (
              <LlmActivityIndicator charactersReceived={streamState.llmPreviewLength} />
            ) : null}

            {deferredReport ? (
              <>
                <ReportSummary report={deferredReport} runDiff={runDiff} />
                <IssueInventoryPanel addedIdentities={addedIdentities} report={deferredReport} />

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

            {appError ? (
              <p className="app-error" role="alert">
                {appError}
              </p>
            ) : null}
          </div>
        </main>
      )}
    </div>
  );
}
