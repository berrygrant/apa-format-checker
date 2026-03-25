export async function createReviewJob(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/review", {
    method: "POST",
    body: formData,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Unable to start the APA review.");
  }

  return payload;
}

function parseEventPayload(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

export function openReviewStream(jobId, handlers) {
  const source = new EventSource(`/api/review/stream/${jobId}`);

  const attach = (eventName, handler) => {
    if (!handler) {
      return;
    }

    source.addEventListener(eventName, (event) => {
      const payload = parseEventPayload(event);
      if (payload) {
        handler(payload);
      }
    });
  };

  attach("snapshot", handlers.onSnapshot);
  attach("status", handlers.onStatus);
  attach("section", handlers.onSection);
  attach("llm_delta", handlers.onLlmDelta);
  attach("complete", handlers.onComplete);
  attach("review_error", handlers.onErrorEvent);

  source.onerror = () => {
    handlers.onConnectionError?.(source.readyState);
  };

  return source;
}
