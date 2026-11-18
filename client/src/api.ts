declare global {
  interface Window {
    relayDesktop?: { apiOrigin: string };
  }
}

const desktopApiOrigin = (() => {
  const value = window.relayDesktop?.apiOrigin?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
})();

const configuredBase = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
export const apiBase = desktopApiOrigin
  ? `${desktopApiOrigin}/api`
  : (configuredBase || '/api').replace(/\/$/, '');
export const apiOrigin = desktopApiOrigin
  || (apiBase.startsWith('http') ? apiBase.replace(/\/api$/, '') : window.location.origin);

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: Record<string, any>) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = { method?: string; body?: unknown; headers?: HeadersInit };
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(options.headers || {});
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-Relay-Request', '1');
  let body: BodyInit | undefined;
  if (options.body instanceof FormData || options.body instanceof Blob) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(url, { method, credentials: 'include', headers, body });
  } catch {
    throw new ApiError('Relay could not reach the server. Check the API URL and whether the server is running.', 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(
    typeof data?.error === 'string' ? data.error : `Request failed (${response.status}).`,
    response.status,
    typeof data?.code === 'string' ? data.code : undefined,
    data && typeof data === 'object' ? data : undefined
  );
  return data as T;
}
export const api = <T = any>(path: string) => request<T>(path);
export const post = <T = any>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
export const put = <T = any>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body });
export const patch = <T = any>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body });
export const del = <T = any>(path: string) => request<T>(path, { method: 'DELETE' });
