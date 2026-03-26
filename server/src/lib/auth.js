import crypto from "node:crypto";
import { APP_AUTH_HOST, APP_PASSWORD, APP_SESSION_SECRET, AUTH_SESSION_TTL_MS } from "./config.js";

const AUTH_COOKIE_NAME = "apa_access";

function parseCookies(cookieHeader) {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader.split(";").reduce((cookies, part) => {
    const [rawName, ...rawValueParts] = part.trim().split("=");

    if (!rawName) {
      return cookies;
    }

    try {
      cookies[rawName] = decodeURIComponent(rawValueParts.join("=") || "");
    } catch {
      cookies[rawName] = rawValueParts.join("=") || "";
    }

    return cookies;
  }, {});
}

function hostnameMatches(req) {
  if (!APP_AUTH_HOST) {
    return true;
  }

  return String(req.hostname || "").trim().toLowerCase() === APP_AUTH_HOST;
}

function isCookieSecure(req) {
  return req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function makeSignature(expiresAt) {
  return crypto.createHmac("sha256", APP_SESSION_SECRET).update(String(expiresAt)).digest("base64url");
}

function setAuthCookie(req, res, expiresAt) {
  const value = `${expiresAt}.${makeSignature(expiresAt)}`;
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];

  if (isCookieSecure(req)) {
    cookieParts.push("Secure");
  }

  res.setHeader("Set-Cookie", [cookieParts.join("; ")]);
}

function clearAuthCookie(req, res) {
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];

  if (isCookieSecure(req)) {
    cookieParts.push("Secure");
  }

  res.setHeader("Set-Cookie", [cookieParts.join("; ")]);
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function isAuthRequiredForRequest(req) {
  return Boolean(APP_PASSWORD && APP_SESSION_SECRET && hostnameMatches(req));
}

export function isRequestAuthenticated(req) {
  if (!isAuthRequiredForRequest(req)) {
    return true;
  }

  const cookieValue = parseCookies(req.headers.cookie || "")[AUTH_COOKIE_NAME];

  if (!cookieValue) {
    return false;
  }

  const [expiresAtText, signature] = cookieValue.split(".");
  const expiresAt = Number.parseInt(expiresAtText ?? "", 10);

  if (!Number.isFinite(expiresAt) || !signature || expiresAt <= Date.now()) {
    return false;
  }

  return timingSafeEqualString(signature, makeSignature(expiresAt));
}

export function getAuthSession(req, res) {
  res.json({
    enabled: isAuthRequiredForRequest(req),
    authenticated: isRequestAuthenticated(req),
    hostScopedTo: APP_AUTH_HOST || null,
  });
}

export function loginWithPassword(req, res) {
  if (!isAuthRequiredForRequest(req)) {
    res.json({
      enabled: false,
      authenticated: true,
      hostScopedTo: APP_AUTH_HOST || null,
    });
    return;
  }

  const password = String(req.body?.password ?? "");

  if (!timingSafeEqualString(password, APP_PASSWORD)) {
    clearAuthCookie(req, res);
    res.status(401).json({
      error: "Incorrect password.",
      code: "AUTH_REQUIRED",
    });
    return;
  }

  const expiresAt = Date.now() + AUTH_SESSION_TTL_MS;
  setAuthCookie(req, res, expiresAt);

  res.json({
    enabled: true,
    authenticated: true,
    expiresAt: new Date(expiresAt).toISOString(),
    hostScopedTo: APP_AUTH_HOST || null,
  });
}

export function logoutSession(req, res) {
  clearAuthCookie(req, res);
  res.status(204).end();
}

export function requireAppAuth(req, res, next) {
  if (isRequestAuthenticated(req)) {
    next();
    return;
  }

  res.status(401).json({
    error: "Password authentication is required.",
    code: "AUTH_REQUIRED",
  });
}
