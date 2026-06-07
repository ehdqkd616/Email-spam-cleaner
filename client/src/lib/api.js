const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // 인증
  getStatus:       ()             => request('/auth/status'),
  startGmailAuth:  ()             => request('/auth/gmail'),
  connectImap:     (data)         => request('/auth/imap', { method: 'POST', body: JSON.stringify(data) }),
  startCauAuth:    ()             => request('/auth/cau/start'),
  pollCauAuth:     ()             => request('/auth/cau/poll'),
  disconnect:      (provider)     => request(`/auth/${provider}`, { method: 'DELETE' }),

  // 메일
  getQueries:      (provider)     => request(`/mail/${provider}/queries`),
  execute:         (provider, data) => request(`/mail/${provider}/execute`, { method: 'POST', body: JSON.stringify(data) }),

  // 로그
  getLogs:         (params = {})  => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v)));
    return request(`/logs?${qs}`);
  },
  getLogDates:     ()             => request('/logs/dates'),

  // 분류 내역
  getHistory:      (params = {})  => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v)));
    return request(`/mail/history?${qs}`);
  },
};

// SSE 스트림 헬퍼
export function scanStream(provider, keys, readFilter, onEvent, onError) {
  const params = new URLSearchParams({ keys: keys.join(','), readFilter });
  const es = new EventSource(`/api/mail/${provider}/scan?${params}`, { withCredentials: true });

  ['start', 'progress', 'complete', 'error'].forEach((ev) => {
    es.addEventListener(ev, (e) => onEvent(ev, JSON.parse(e.data)));
  });
  es.onerror = (e) => { onError(e); es.close(); };
  return () => es.close();
}

export function categorizeStream(provider, onEvent, onError) {
  const es = new EventSource(`/api/mail/${provider}/categorize`, { withCredentials: true });
  ['log', 'complete', 'error'].forEach((ev) => {
    es.addEventListener(ev, (e) => onEvent(ev, JSON.parse(e.data)));
  });
  es.onerror = (e) => { onError(e); es.close(); };
  return () => es.close();
}
