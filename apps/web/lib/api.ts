const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const CSRF_COOKIE_NAME = "vacancy_radar_csrf";

function readCookie(name: string) {
  if (typeof document === "undefined") return null;
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;
}

async function getCsrfToken() {
  const existingToken = readCookie(CSRF_COOKIE_NAME);
  if (existingToken) return decodeURIComponent(existingToken);

  const response = await fetch(`${API_URL}/auth/csrf`, {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`CSRF token request failed: ${response.status}`);
  const payload = await response.json() as { csrfToken?: string };
  return payload.csrfToken ?? readCookie(CSRF_COOKIE_NAME) ?? "";
}

function isStateChangingMethod(method?: string) {
  const normalizedMethod = (method ?? "GET").toUpperCase();
  return normalizedMethod !== "GET" && normalizedMethod !== "HEAD" && normalizedMethod !== "OPTIONS";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const csrfToken = isStateChangingMethod(init?.method) ? await getCsrfToken() : null;
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`API ${path} failed: ${response.status}`);
  }
  return response.json();
}

export { API_URL };
