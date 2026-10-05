async function req(path: string, init?: RequestInit) {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (res.status === 401) {
    if (!location.hash.startsWith('#/masuk')) location.hash = '#/masuk';
    throw new Error('Belum masuk');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json;
}

export const api = {
  get: (p: string) => req(p),
  post: (p: string, body: unknown) => req(p, { method: 'POST', body: JSON.stringify(body) }),
  put: (p: string, body: unknown) => req(p, { method: 'PUT', body: JSON.stringify(body) }),
  patch: (p: string, body: unknown) => req(p, { method: 'PATCH', body: JSON.stringify(body) }),
  del: (p: string) => req(p, { method: 'DELETE' }),
};
