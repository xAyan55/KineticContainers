const BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as { data?: T; error?: { code: string; message: string; details?: unknown } }) : {};
  if (!res.ok) {
    throw new ApiError(body.error?.code ?? "REQUEST_FAILED", body.error?.message ?? "Request failed.", res.status, body.error?.details);
  }
  return (body.data ?? {}) as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" }),
};

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  avatar_seed: string;
  created_at: string;
}

export interface Instance {
  id: string;
  name: string;
  container_id: string;
  node_id: string | null;
  node_name: string | null;
  status: string;
  cpu: number;
  memory_mb: number;
  storage_gb: number;
  template: string | null;
  ip_address: string | null;
  created_at: string;
  updated_at: string;
}
