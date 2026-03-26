export class UnauthorizedError extends Error {
  constructor(message = "Password authentication is required.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

async function parsePayload(response) {
  return response.json().catch(() => ({}));
}

function throwIfUnauthorized(response, payload) {
  if (response.status === 401 || payload?.code === "AUTH_REQUIRED") {
    throw new UnauthorizedError(payload?.error || "Password authentication is required.");
  }
}

export async function createReviewJob(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/review", {
    method: "POST",
    body: formData,
  });

  const payload = await parsePayload(response);
  throwIfUnauthorized(response, payload);

  if (!response.ok) {
    throw new Error(payload.error || "Unable to start the APA review.");
  }

  return payload;
}

export async function getAuthSession() {
  const response = await fetch("/api/auth/session");
  const payload = await parsePayload(response);

  if (!response.ok) {
    throw new Error(payload.error || "Unable to load the authentication state.");
  }

  return payload;
}

export async function loginWithPassword(password) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password }),
  });

  const payload = await parsePayload(response);
  throwIfUnauthorized(response, payload);

  if (!response.ok) {
    throw new Error(payload.error || "Unable to verify the password.");
  }

  return payload;
}

export async function logoutSession() {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
  });

  if (!response.ok) {
    const payload = await parsePayload(response);
    throw new Error(payload.error || "Unable to sign out.");
  }
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
