/** Client: empty = same-origin (Next rewrites /api → Flask). Set NEXT_PUBLIC_API_URL only if the API is on another origin. */
function clientApiBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (raw == null || String(raw).trim() === "") return "";
  return String(raw).trim().replace(/\/$/, "");
}

export const API_BASE =
  typeof window !== "undefined"
    ? clientApiBase()
    : clientApiBase() || "http://127.0.0.1:5000";

export async function apiFetch(path: string, init?: RequestInit) {
  const base = API_BASE;
  const pathPart = path.startsWith("/") ? path : `/${path}`;
  const url = base ? `${base}${pathPart}` : pathPart;
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

export const REFERRAL_STORAGE_KEY = "zenith_referral_code";

export function readStoredReferral(): string {
  if (typeof window === "undefined") return "";
  try {
    return sessionStorage.getItem(REFERRAL_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function writeStoredReferral(code: string) {
  if (typeof window === "undefined") return;
  try {
    if (!code) sessionStorage.removeItem(REFERRAL_STORAGE_KEY);
    else sessionStorage.setItem(REFERRAL_STORAGE_KEY, code.toLowerCase());
  } catch {
    /* ignore */
  }
}
