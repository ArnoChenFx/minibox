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
    throw new ApiError(0, "network", "无法连接服务器，请检查网络后重试。");
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
    throw new ApiError(401, "unauthorized", "登录已失效，请重新登录。");
  }
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? "http_error",
      err.message ?? `请求失败（HTTP ${res.status}）`,
      err.details,
    );
  }
  return data;
}

export const enc = encodeURIComponent;
