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

function parseEventPayload(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function dispatchStreamEvent(event, handlers) {
  const payload = parseEventPayload(event);

  if (!payload) {
    return;
  }

  const eventHandlers = {
    snapshot: handlers.onSnapshot,
    status: handlers.onStatus,
    section: handlers.onSection,
    llm_delta: handlers.onLlmDelta,
    complete: handlers.onComplete,
    review_error: handlers.onErrorEvent,
  };

  eventHandlers[event.type]?.(payload);
}

function parseSseEvent(rawEvent) {
  const event = {
    type: "message",
    data: "",
  };

  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") {
      event.type = value || "message";
    } else if (field === "data") {
      event.data += event.data ? `\n${value}` : value;
    } else if (field === "id") {
      event.id = value;
    }
  }

  return event.data ? event : null;
}

async function readSseStream(body, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const rawEvent of events) {
      const event = parseSseEvent(rawEvent);
      if (event) {
        dispatchStreamEvent(event, handlers);
      }
    }
  }

  buffer += decoder.decode();
  const event = parseSseEvent(buffer);
  if (event) {
    dispatchStreamEvent(event, handlers);
  }
}

export async function runReviewStream(file, reviewMode = "standard", handlers = {}, options = {}) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("reviewMode", reviewMode);

  const response = await fetch("/api/review/stream", {
    method: "POST",
    body: formData,
    signal: options.signal,
  });
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    const payload = contentType.includes("application/json") ? await parsePayload(response) : {};
    throwIfUnauthorized(response, payload);
    throw new Error(payload.error || "Unable to run the APA review.");
  }

  if (!response.body) {
    throw new Error("The review stream did not return a readable response body.");
  }

  await readSseStream(response.body, handlers);
}

function readCountHeader(response, name) {
  const value = Number.parseInt(response.headers.get(name) ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function annotateDocument(file, issues) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("issues", JSON.stringify(issues ?? []));

  const response = await fetch("/api/review/annotate", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await parsePayload(response) : {};
    throwIfUnauthorized(response, payload);
    throw new Error(payload.error || "Unable to build the annotated document.");
  }

  return {
    blob: await response.blob(),
    anchoredCount: readCountHeader(response, "X-Annotated-Count"),
    unanchoredCount: readCountHeader(response, "X-Unanchored-Count"),
  };
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
