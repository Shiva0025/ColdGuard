const TOKEN_KEY = 'coldguard.token';
const USER_KEY = 'coldguard.user';

export interface SessionUser {
  username: string;
  role: 'operator' | 'viewer';
  displayName: string;
  groups: string[];
}

/**
 * Per-tab session (sessionStorage) so two different users can be demonstrated
 * side by side in one browser. Tokens are short-lived JWTs (8 h).
 */
export const session = {
  get token(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  get user(): SessionUser | null {
    try {
      const s = sessionStorage.getItem(USER_KEY);
      return s ? (JSON.parse(s) as SessionUser) : null;
    } catch {
      return null;
    }
  },
  set(token: string, user: SessionUser) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {
      /* storage unavailable: session lasts for this page only */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    } catch {
      /* ignore */
    }
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const tok = session.token;
  if (tok) headers.set('authorization', `Bearer ${tok}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && tok) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, (data as any)?.error ?? `HTTP ${res.status}`, data);
  return data as T;
}

/** Authenticated download: fetch with the bearer token, then hand the blob to the browser. */
export async function downloadFile(path: string, filename: string): Promise<{ truncated: boolean }> {
  const headers = new Headers();
  const tok = session.token;
  if (tok) headers.set('authorization', `Bearer ${tok}`);
  const res = await fetch(`/api${path}`, { headers });
  if (res.status === 401 && tok) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { truncated: res.headers.get('x-truncated') === '1' };
}
