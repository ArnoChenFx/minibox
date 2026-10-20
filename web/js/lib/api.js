import { has, t } from "./i18n.js";

/** Translate a server error `{ code, message, key?, params? }` into the UI language. */
function serverMessage(err, status) {
  if (err.key && has(`err.${err.key}`)) {
    const params = { ...err.params };
    if (typeof params.label === "string" && has(`label.${params.label}`)) params.label = t(`label.${params.label}`);
    return t(`err.${err.key}`, params);
  }
  return err.message ?? t("api.httpError", { status });
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** JSON fetch wrapper. Redirects to /login on 401. Throws ApiError with the server's `{error:{code,message}}`. */
export async function api(path, { method = "GET", body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError(0, "network", t("api.network"));
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    location.href = "/login";
    throw new ApiError(401, "unauthorized", t("api.sessionExpired"));
  }
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "http_error", serverMessage(err, res.status), err.details);
  }
  return data;
}

export const enc = encodeURIComponent;
