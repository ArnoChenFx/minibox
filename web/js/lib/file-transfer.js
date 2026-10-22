import { ApiError, errorHint, errorText } from "./api.js";
import { t } from "./i18n.js";

/**
 * Sends one file as the raw body of a PUT. XMLHttpRequest, not fetch: only it reports the bytes that have left the browser,
 * which the progress bar shows. `done` settles with the reply, or rejects with an ApiError, or with an AbortError after
 * `abort()`.
 */
export function sendFile(url, file, { onProgress } = {}) {
  const xhr = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => onProgress?.(event.loaded));
    xhr.addEventListener("load", () => {
      const reply = parse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) return resolve(reply);
      if (xhr.status === 401) location.href = "/login";
      return reject(failureOf(xhr.status, reply));
    });
    xhr.addEventListener("error", () => reject(new ApiError(0, "network", t("api.network"))));
    xhr.addEventListener("abort", () => reject(new DOMException(t("fl.uploadCancelled"), "AbortError")));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function failureOf(status, reply) {
  const err = reply?.error ?? {};
  return new ApiError(status, err.code ?? "http_error", errorText(err, status), err.details, errorHint(err), err.key);
}
