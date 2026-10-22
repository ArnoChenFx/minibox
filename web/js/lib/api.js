import { has, t } from "./i18n.js";

/** Translate a server error `{ code, message, key?, params? }` into the UI language. */
export function errorText(err, status = 0) {
  if (err?.key && has(`err.${err.key}`)) {
    const params = { ...err.params };
    if (typeof params.label === "string" && has(`label.${params.label}`)) params.label = t(`label.${params.label}`);
    if (typeof params.feature === "string" && has(`feature.${params.feature}`)) {
      params.feature = t(`feature.${params.feature}`);
    }
    return t(`err.${err.key}`, params);
  }
  return err?.message ?? t("api.httpError", { status });
}

/** The retry or next-step hint of a server error, translated, or `""` when there is none. */
export function errorHint(err) {
  if (err?.hintKey && has(`err.${err.hintKey}`)) return t(`err.${err.hintKey}`, { ...err.hintParams });
  return err?.hint ?? "";
}

export class ApiError extends Error {
  constructor(status, code, message, details, hint = "", key = "") {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
    this.key = key;
  }
}

/** JSON fetch wrapper. Redirects to /login on 401. Throws ApiError with the server's `{error:{code,message}}`. */
export async function api(path, { method = "GET", body, signal, headers } = {}) {
  let res;
  try {
    const init = { method, signal, credentials: "same-origin" };
    const hdrs = new Headers(headers);
    if (body !== undefined) {
      if (!hdrs.has("content-type")) hdrs.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    init.headers = hdrs;
    res = await fetch(path, init);
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
    throw new ApiError(
      res.status,
      err.code ?? "http_error",
      errorText(err, res.status),
      err.details,
      errorHint(err),
      err.key,
    );
  }
  return data;
}

export const enc = encodeURIComponent;
