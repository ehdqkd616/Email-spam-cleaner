import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api, scanStream, categorizeStream, migrateFoldersStream } from '../lib/api';
import { PROVIDERS, cn } from '../lib/utils';
import Button from '../components/Button';
import Toast from '../components/Toast';
import { PROVIDER_LOGOS } from '../components/ProviderLogo';

const READ_FILTERS = [
  { value: '',          label: '전체' },
  { value: 'is:unread', label: '미열람' },
  { value: 'is:read',   label: '열람' },
];

const S = {
  card: {
    background: 'white',
    borderRadius: 20,
    border: '1px solid #e2e8f0',
    boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
    overflow: 'hidden',
    transition: 'box-shadow 0.2s ease',
  },
  cardHeader: {
    padding: '18px 24px',
    borderBottom: '1px solid #f1f5f9',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  cardBody: {
    padding: '24px',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 12,
  },
};

export default function Dashboard() {
  const navigate             = useNavigate();
  const location             = useLocation();
  const [status, setStatus]  = useState({});
  const [selected, select]   = useState(null);
  const [queries, setQueries]= useState({});
  const [checkedKeys, setChecked] = useState([]);
  const [readFilter, setFilter]   = useState('');
  const [scanResult, setScan]     = useState(null);
  const [loading, setLoading]     = useState('');
  const [progress, setProgress]   = useState([]);
  const [logs, setLogs]           = useState([]);
  const [migrateLogs, setMigrateLogs] = useState([]);
  const [toast, setToast]         = useState(null);
  const [sidebarOpen, setSidebar] = useState(false);
  const [serverLogs, setServerLogs]     = useState([]);
  const [logFilter, setLogFilter]       = useState({ level: '', category: '' });
  const [logLoading, setLogLoading]     = useState(false);
  const [logDate, setLogDate]           = useState('');
  const [logDates, setLogDates]         = useState([]);
  const [logPanelOpen, setLogPanel]     = useState(false);
  const [historyRecords, setHistory]    = useState([]);
  const [historyLoading, setHistLoading]= useState(false);
  const [historyOpen, setHistoryOpen]   = useState(false);

  useEffect(() => {
    (async () => {
      const s = await api.getStatus();
      setStatus(s);
      const initial = location.state?.provider || Object.keys(s).find((k) => s[k]?.connected);
      if (initial && s[initial]?.connected) await doSelect(initial, s);
      // 로그 날짜 목록 미리 로드
      try {
        const { dates } = await api.getLogDates();
        setLogDates(dates);
      } catch (_) {}
    })();
  }, []);

  async function doSelect(key, statusOverride) {
    const s = statusOverride || status;
    if (!s[key]?.connected) return;
    select(key);
    setScan(null); setProgress([]); setLogs([]); setSidebar(false);
    try {
      const q = await api.getQueries(key);
      setQueries(q);
      setChecked(Object.keys(q).filter((k) => q[k].safe));
    } catch (_) { setQueries({}); }
  }

  function showToast(msg, type = 'success') {
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  function handleScan() {
    if (!checkedKeys.length) return showToast('카테고리를 선택해주세요', 'error');
    setLoading('scan'); setScan(null); setProgress([]);
    const stop = scanStream(selected, checkedKeys, readFilter,
      (ev, data) => {
        if (ev === 'progress') setProgress((p) => [...p.filter((x) => x.key !== data.key), data]);
        if (ev === 'complete') { setScan(data.results); setLoading(''); stop(); }
        if (ev === 'error')   { showToast(data.message, 'error'); setLoading(''); stop(); }
      },
      () => { showToast('스캔 오류', 'error'); setLoading(''); }
    );
  }

  async function handleExecute(action) {
    const ids = Object.values(scanResult || {}).flatMap((r) => r.ids || []);
    if (!ids.length) return showToast('처리할 메일이 없습니다', 'error');
    const labels = { trash: '휴지통 이동', delete: '영구 삭제', spam: '스팸 처리' };
    setLoading(action);
    try {
      const { count } = await api.execute(selected, { ids, action });
      showToast(`${count}개 메일 ${labels[action]} 완료!`);
      setScan(null); setProgress([]);
    } catch (err) { showToast(err.message, 'error'); }
    finally { setLoading(''); }
  }

  function handleCategorize() {
    setLoading('categorize'); setLogs([]);
    const stop = categorizeStream(selected,
      (ev, data) => {
        if (ev === 'log')     setLogs((l) => [...l, data.message]);
        if (ev === 'complete') {
          showToast('자동 분류 완료!'); setLoading(''); stop();
          if (historyOpen) fetchHistory(); else fetchHistory().then(() => {});
        }
        if (ev === 'error')   { showToast(data.message, 'error'); setLoading(''); stop(); }
      },
      () => { showToast('분류 오류', 'error'); setLoading(''); }
    );
  }

  function handleMigrateFolders() {
    setLoading('migrate'); setMigrateLogs([]);
    const stop = migrateFoldersStream(selected,
      (ev, data) => {
        if (ev === 'log')      setMigrateLogs((l) => [...l, data]);
        if (ev === 'complete') { showToast(`폴더 이름 변경 완료! (${data.total}개 이동)`); setLoading(''); stop(); }
        if (ev === 'error')    { showToast(data.message, 'error'); setLoading(''); stop(); }
      },
      () => { showToast('마이그레이션 오류', 'error'); setLoading(''); }
    );
  }

  async function fetchLogs() {
    setLogLoading(true);
    try {
      const params = { limit: 200 };
      if (logFilter.level)    params.level    = logFilter.level;
      if (logFilter.category) params.category = logFilter.category;
      if (logDate)            params.date     = logDate;
      const { entries } = await api.getLogs(params);
      setServerLogs(entries.reverse());
    } catch (_) { showToast('로그 조회 실패', 'error'); }
    finally { setLogLoading(false); }
  }

  useEffect(() => {
    if (logPanelOpen) fetchLogs();
  }, [logPanelOpen, logFilter, logDate]);

  async function fetchHistory() {
    setHistLoading(true);
    try {
      const records = await api.getHistory({ limit: 50 });
      setHistory(records);
    } catch (_) { showToast('내역 조회 실패', 'error'); }
    finally { setHistLoading(false); }
  }

  useEffect(() => {
    if (historyOpen) fetchHistory();
  }, [historyOpen]);

  const LEVEL_STYLE = {
    INFO:    { bg: '#dbeafe', color: '#1d4ed8', border: '#bfdbfe' },
    SUCCESS: { bg: '#dcfce7', color: '#15803d', border: '#bbf7d0' },
    WARN:    { bg: '#fef9c3', color: '#a16207', border: '#fde047' },
    ERROR:   { bg: '#fee2e2', color: '#b91c1c', border: '#fca5a5' },
  };

  const CAT_LABELS = ['AUTH', 'SCAN', 'CATEGORIZE', 'CLEAN', 'SPAM', 'FILTER', 'BLOCK', 'SYSTEM'];

  const connectedProviders = Object.entries(status).filter(([, s]) => s?.connected);
  const totalScanned = Object.values(scanResult || {}).reduce((s, r) => s + (r.count || 0), 0);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#f8fafc', overflow: 'hidden' }}>

      {/* ── 모바일 헤더 ── */}
      <header style={{ display: 'none', background: 'white', borderBottom: '1px solid #e2e8f0', padding: '12px 20px', alignItems: 'center', gap: 12, flexShrink: 0, zIndex: 30 }}
        className="max-lg:!flex">
        <button
          onClick={() => setSidebar(!sidebarOpen)}
          style={{ width: 38, height: 38, borderRadius: 10, border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, background: 'white', cursor: 'pointer', transition: 'background 0.15s' }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#f8fafc'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
        >
          {[0,1,2].map((i) => (
            <span key={i} className={cn('w-4 h-0.5 bg-slate-600 rounded block transition-all duration-200',
              i === 0 && sidebarOpen && 'rotate-45 translate-y-[6px]',
              i === 1 && sidebarOpen && 'opacity-0 scale-x-0',
              i === 2 && sidebarOpen && '-rotate-45 -translate-y-[6px]',
            )} />
          ))}
        </button>
        <span style={{ fontWeight: 700, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 8 }}>
          {selected && PROVIDER_LOGOS[selected]
            ? <>{(() => { const L = PROVIDER_LOGOS[selected]; return <L size={18} />; })()}{PROVIDERS[selected]?.label}</>
            : selected ? `${PROVIDERS[selected]?.icon} ${PROVIDERS[selected]?.label}` : 'Mail Cleaner'
          }
        </span>
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── 사이드바 배경막 (모바일) ── */}
        {sidebarOpen && (
          <div
            onClick={() => setSidebar(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }}
            className="lg:hidden"
          />
        )}

        {/* ── 사이드바 ── */}
        <aside
          style={{ background: 'white', borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', width: 260, flexShrink: 0 }}
          className={cn(
            'lg:relative lg:translate-x-0',
            'max-lg:fixed max-lg:left-0 max-lg:top-0 max-lg:bottom-0 max-lg:w-72 max-lg:z-50 max-lg:shadow-2xl',
            'max-lg:transition-transform max-lg:duration-300',
            sidebarOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full'
          )}
        >
          {/* 사이드바 상단 */}
          <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid #f1f5f9' }}>
            <Button variant="ghost" size="md" onClick={() => navigate('/')} darkRipple className="!text-slate-400 !font-normal mb-4 gap-1 group">
              <span className="group-hover:-translate-x-0.5 transition-transform inline-block">←</span> 홈
            </Button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg, #3b82f6, #6366f1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, color: 'white' }}>✉</div>
              <span style={{ fontWeight: 800, color: '#1e293b', fontSize: 15 }}>Mail Cleaner</span>
            </div>
          </div>

          {/* 서비스 목록 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 12px' }}>
            <p style={S.sectionLabel}>연결된 서비스</p>
            {connectedProviders.length === 0 && (
              <p style={{ fontSize: 12, color: '#94a3b8', padding: '0 8px' }}>연결된 서비스 없음</p>
            )}
            {connectedProviders.map(([key, s]) => (
              <button
                key={key}
                onClick={() => doSelect(key)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 12px', borderRadius: 12, marginBottom: 4,
                  background: selected === key ? '#eff6ff' : 'transparent',
                  color: selected === key ? '#2563eb' : '#475569',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => { if (selected !== key) e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={(e) => { if (selected !== key) e.currentTarget.style.background = 'transparent'; }}
              >
                {(() => { const Logo = PROVIDER_LOGOS[key]; return Logo
                  ? <span style={{ flexShrink: 0, transition: 'transform 0.15s', display: 'flex' }}
                      onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.15)'}
                      onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                    ><Logo size={20} /></span>
                  : <span style={{ fontSize: 20, flexShrink: 0 }}>{PROVIDERS[key]?.icon}</span>;
                })()}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{PROVIDERS[key]?.label}</p>
                  <p style={{ fontSize: 11, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.email}</p>
                </div>
                {selected === key && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', flexShrink: 0 }} />}
              </button>
            ))}
          </div>

          {/* 서비스 추가 */}
          <div style={{ padding: 16, borderTop: '1px solid #f1f5f9' }}>
            <button
              onClick={() => navigate('/')}
              style={{ width: '100%', padding: '10px 16px', border: '2px dashed #e2e8f0', borderRadius: 12, fontSize: 13, color: '#94a3b8', background: 'none', cursor: 'pointer', transition: 'all 0.15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#93c5fd'; e.currentTarget.style.color = '#3b82f6'; e.currentTarget.style.background = '#eff6ff'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.background = 'none'; }}
            >
              + 서비스 추가
            </button>
          </div>
        </aside>

        {/* ── 메인 콘텐츠 ── */}
        <main style={{ flex: 1, overflowY: 'auto', padding: '32px 24px' }}>
          {!selected ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center', gap: 16 }}>
              <div style={{ width: 64, height: 64, borderRadius: 20, background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>📬</div>
              <div>
                <p style={{ fontWeight: 700, color: '#334155', marginBottom: 6 }}>서비스를 선택하세요</p>
                <p style={{ fontSize: 13, color: '#94a3b8' }}>왼쪽 사이드바에서 서비스를 선택해주세요.</p>
              </div>
              {connectedProviders.length === 0 && (
                <Button variant="primary" onClick={() => navigate('/')}>서비스 연결하기</Button>
              )}
            </div>
          ) : (
            <div style={{ maxWidth: 720, margin: '0 auto' }}>

              {/* 서비스 제목 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }} className="hidden lg:flex">
                {(() => { const L = PROVIDER_LOGOS[selected]; return L ? <L size={36} /> : <span style={{ fontSize: 32 }}>{PROVIDERS[selected]?.icon}</span>; })()}
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 800, color: '#1e293b' }}>{PROVIDERS[selected]?.label}</h2>
                  <p style={{ fontSize: 13, color: '#94a3b8' }}>{status[selected]?.email}</p>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

                {/* ── 자동 분류 ── */}
                <div style={S.card}
                  onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.09)'}
                  onMouseLeave={(e) => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)'}
                >
                  <div style={S.cardHeader}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: '#eff6ff', border: '1px solid #bfdbfe', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📂</div>
                    <div>
                      <p style={{ fontWeight: 700, color: '#1e293b', fontSize: 14 }}>자동 분류</p>
                      <p style={{ fontSize: 12, color: '#94a3b8' }}>받은편지함을 카테고리 폴더로 자동 정리</p>
                    </div>
                  </div>
                  <div style={S.cardBody}>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <Button variant="primary" size="md" onClick={handleCategorize} loading={loading === 'categorize'} disabled={!!loading}>
                        분류 실행
                      </Button>
                      <Button variant="outline" size="md" onClick={handleMigrateFolders} loading={loading === 'migrate'} disabled={!!loading}>
                        폴더 이름 정리
                      </Button>
                    </div>
                    {logs.length > 0 && (
                      <div style={{ marginTop: 16, background: '#f8fafc', borderRadius: 12, padding: 16, maxHeight: 176, overflowY: 'auto', border: '1px solid #e2e8f0' }}>
                        {logs.map((l, i) => (
                          <p key={i} style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace', lineHeight: 1.6 }}>{l}</p>
                        ))}
                      </div>
                    )}
                    {migrateLogs.length > 0 && (
                      <div style={{ marginTop: 16, background: '#f8fafc', borderRadius: 12, padding: 16, maxHeight: 176, overflowY: 'auto', border: '1px solid #e2e8f0' }}>
                        {migrateLogs.map((l, i) => {
                          const color = l.level === 'error' ? '#dc2626' : l.level === 'success' ? '#16a34a' : '#64748b';
                          return <p key={i} style={{ fontSize: 12, color, fontFamily: 'monospace', lineHeight: 1.6 }}>{l.message}</p>;
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* ── 광고·스팸 정리 ── */}
                <div style={S.card}
                  onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.09)'}
                  onMouseLeave={(e) => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)'}
                >
                  <div style={S.cardHeader}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: '#fff1f2', border: '1px solid #fecdd3', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🗑️</div>
                    <div>
                      <p style={{ fontWeight: 700, color: '#1e293b', fontSize: 14 }}>광고·스팸 정리</p>
                      <p style={{ fontSize: 12, color: '#94a3b8' }}>조건에 맞는 메일을 스캔하고 일괄 처리</p>
                    </div>
                  </div>
                  <div style={S.cardBody}>

                    {/* 읽음 필터 */}
                    <p style={S.sectionLabel}>읽음 상태</p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
                      {READ_FILTERS.map((f) => (
                        <Button
                          key={f.value}
                          variant={readFilter === f.value ? 'blue' : 'outline'}
                          size="sm"
                          darkRipple={readFilter !== f.value}
                          onClick={() => setFilter(f.value)}
                          className={readFilter === f.value ? 'scale-[1.03] shadow-blue-200' : ''}
                        >
                          {f.label}
                        </Button>
                      ))}
                    </div>

                    {/* 카테고리 */}
                    <p style={S.sectionLabel}>카테고리 선택</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                      {Object.entries(queries).map(([key, q]) => {
                        const checked = checkedKeys.includes(key);
                        return (
                          <label
                            key={key}
                            style={{
                              display: 'flex', alignItems: 'flex-start', gap: 14,
                              padding: '14px 16px', borderRadius: 14, cursor: 'pointer',
                              border: `1.5px solid ${checked ? '#93c5fd' : '#e2e8f0'}`,
                              background: checked ? '#eff6ff' : '#f8fafc',
                              transition: 'all 0.15s ease',
                              boxShadow: checked ? '0 2px 8px rgba(59,130,246,0.1)' : 'none',
                            }}
                            onMouseEnter={(e) => { if (!checked) { e.currentTarget.style.borderColor = '#cbd5e1'; e.currentTarget.style.background = 'white'; } }}
                            onMouseLeave={(e) => { if (!checked) { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.background = '#f8fafc'; } }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => setChecked((prev) => e.target.checked ? [...prev, key] : prev.filter((k) => k !== key))}
                              className="custom-check"
                              style={{ marginTop: 2 }}
                            />
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b' }}>{q.name}</span>
                                {q.safe && <span style={{ fontSize: 11, padding: '2px 8px', background: '#dcfce7', color: '#16a34a', borderRadius: 999, fontWeight: 700, border: '1px solid #bbf7d0' }}>안전</span>}
                              </div>
                              <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 3, lineHeight: 1.5 }}>{q.description}</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>

                    <Button variant="blue" size="md" onClick={handleScan} loading={loading === 'scan'} disabled={!!loading}>
                      📋 미리보기 스캔
                    </Button>

                    {/* 진행 상황 */}
                    {progress.length > 0 && (
                      <div style={{ marginTop: 20, background: '#f8fafc', borderRadius: 14, padding: '16px 20px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {progress.map((p) => (
                          <div key={p.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 13, color: '#475569' }}>{p.name}</span>
                            <span style={{
                              fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                              background: p.status === 'done' ? '#dcfce7' : '#dbeafe',
                              color: p.status === 'done' ? '#16a34a' : '#2563eb',
                              border: `1px solid ${p.status === 'done' ? '#bbf7d0' : '#bfdbfe'}`,
                              transition: 'all 0.3s ease',
                            }}>
                              {p.status === 'done' ? `✓ ${p.count}개` : '스캔 중...'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* ── 스캔 결과 ── */}
                    {scanResult && (
                      <div style={{ marginTop: 28, borderTop: '1px solid #f1f5f9', paddingTop: 24 }} className="card-appear">
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                          <p style={{ fontWeight: 800, color: '#1e293b', fontSize: 15 }}>
                            총 <span style={{ fontSize: 26, color: '#2563eb' }}>{totalScanned}</span>개 발견
                          </p>
                          <Button variant="ghost" size="xs" onClick={() => { setScan(null); setProgress([]); }} darkRipple className="text-slate-400">초기화</Button>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
                          {Object.entries(scanResult).map(([key, result]) =>
                            result.count > 0 ? (
                              <div key={key} style={{ background: '#f8fafc', borderRadius: 14, border: '1px solid #e2e8f0', overflow: 'hidden', transition: 'box-shadow 0.2s' }}
                                onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.07)'}
                                onMouseLeave={(e) => e.currentTarget.style.boxShadow = 'none'}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'white', borderBottom: '1px solid #f1f5f9' }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>{result.name}</span>
                                  <span style={{ fontSize: 13, fontWeight: 800, color: '#2563eb', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '2px 10px', borderRadius: 999 }}>{result.count}개</span>
                                </div>
                                {result.samples?.slice(0, 3).map((s, i) => (
                                  <div key={i} style={{ padding: '10px 16px', borderBottom: i < 2 && result.samples.length > 1 ? '1px solid #f1f5f9' : 'none', transition: 'background 0.1s' }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.7)'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <p style={{ fontSize: 13, color: '#334155', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.subject || '(제목 없음)'}</p>
                                    <p style={{ fontSize: 11, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{s.from}</p>
                                  </div>
                                ))}
                                {result.count > 3 && (
                                  <div style={{ padding: '8px 16px', fontSize: 12, color: '#94a3b8' }}>+ {result.count - 3}개 더...</div>
                                )}
                              </div>
                            ) : null
                          )}
                        </div>

                        {/* 실행 버튼 */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
                          <Button variant="amber" size="md" onClick={() => handleExecute('trash')} loading={loading === 'trash'} disabled={!!loading} fullWidth>
                            🗑️ 휴지통
                          </Button>
                          <Button variant="orange" size="md" onClick={() => handleExecute('spam')} loading={loading === 'spam'} disabled={!!loading} fullWidth>
                            🚫 스팸
                          </Button>
                          <Button variant="danger" size="md" onClick={() => handleExecute('delete')} loading={loading === 'delete'} disabled={!!loading} fullWidth>
                            ⚠️ 삭제
                          </Button>
                        </div>
                        <p style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>영구 삭제는 복구 불가 — 신중하게 선택하세요</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── 로그 뷰어 ── */}
              <div style={{ ...S.card, marginTop: 20 }}
                onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.09)'}
                onMouseLeave={(e) => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)'}
              >
                <div
                  style={{ ...S.cardHeader, cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setLogPanel((o) => !o)}
                >
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📋</div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontWeight: 700, color: '#1e293b', fontSize: 14 }}>작업 로그</p>
                    <p style={{ fontSize: 12, color: '#94a3b8' }}>로그인·스캔·분류·삭제 등 모든 작업 기록</p>
                  </div>
                  <span style={{ fontSize: 18, color: '#94a3b8', transform: logPanelOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>⌄</span>
                </div>

                {logPanelOpen && (
                  <div style={S.cardBody}>

                    {/* 필터 바 */}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
                      {/* 레벨 필터 */}
                      <select
                        value={logFilter.level}
                        onChange={(e) => setLogFilter((f) => ({ ...f, level: e.target.value }))}
                        style={{ fontSize: 12, padding: '5px 10px', borderRadius: 8, border: '1px solid #e2e8f0', color: '#475569', background: 'white', cursor: 'pointer' }}
                      >
                        <option value="">전체 레벨</option>
                        {['INFO', 'SUCCESS', 'WARN', 'ERROR'].map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>

                      {/* 카테고리 필터 */}
                      <select
                        value={logFilter.category}
                        onChange={(e) => setLogFilter((f) => ({ ...f, category: e.target.value }))}
                        style={{ fontSize: 12, padding: '5px 10px', borderRadius: 8, border: '1px solid #e2e8f0', color: '#475569', background: 'white', cursor: 'pointer' }}
                      >
                        <option value="">전체 카테고리</option>
                        {CAT_LABELS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>

                      {/* 날짜 선택 */}
                      {logDates.length > 0 && (
                        <select
                          value={logDate}
                          onChange={(e) => setLogDate(e.target.value)}
                          style={{ fontSize: 12, padding: '5px 10px', borderRadius: 8, border: '1px solid #e2e8f0', color: '#475569', background: 'white', cursor: 'pointer' }}
                        >
                          <option value="">오늘</option>
                          {logDates.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                      )}

                      <button
                        onClick={fetchLogs}
                        disabled={logLoading}
                        style={{ fontSize: 12, padding: '5px 12px', borderRadius: 8, border: '1px solid #e2e8f0', color: '#475569', background: logLoading ? '#f1f5f9' : 'white', cursor: logLoading ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
                      >
                        {logLoading ? '로딩...' : '↻ 새로고침'}
                      </button>

                      {serverLogs.length > 0 && (
                        <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 'auto' }}>{serverLogs.length}개 항목</span>
                      )}
                    </div>

                    {/* 로그 목록 */}
                    <div style={{ background: '#0f172a', borderRadius: 12, padding: 16, maxHeight: 360, overflowY: 'auto', fontFamily: 'monospace' }}>
                      {logLoading ? (
                        <p style={{ fontSize: 12, color: '#64748b', textAlign: 'center', padding: '20px 0' }}>로그 불러오는 중...</p>
                      ) : serverLogs.length === 0 ? (
                        <p style={{ fontSize: 12, color: '#475569', textAlign: 'center', padding: '20px 0' }}>로그가 없습니다. 작업을 실행하면 여기에 표시됩니다.</p>
                      ) : (
                        serverLogs.map((entry, i) => {
                          const ls = LEVEL_STYLE[entry.level] || LEVEL_STYLE.INFO;
                          return (
                            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0', borderBottom: i < serverLogs.length - 1 ? '1px solid #1e293b' : 'none' }}>
                              <span style={{ fontSize: 10, color: '#475569', whiteSpace: 'nowrap', paddingTop: 2, minWidth: 130 }}>{entry.ts.slice(11)}</span>
                              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: ls.bg, color: ls.color, border: `1px solid ${ls.border}`, whiteSpace: 'nowrap', minWidth: 56, textAlign: 'center' }}>{entry.level}</span>
                              <span style={{ fontSize: 10, color: '#64748b', whiteSpace: 'nowrap', minWidth: 80 }}>[{entry.category}]</span>
                              <span style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.5, wordBreak: 'break-all' }}>{entry.message}</span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ── 분류 내역 ── */}
              <div style={{ ...S.card, marginTop: 20 }}
                onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.09)'}
                onMouseLeave={(e) => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)'}
              >
                <div
                  style={{ ...S.cardHeader, cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setHistoryOpen((o) => !o)}
                >
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📁</div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontWeight: 700, color: '#1e293b', fontSize: 14 }}>분류 내역</p>
                    <p style={{ fontSize: 12, color: '#94a3b8' }}>자동 분류 실행 이력 및 카테고리별 처리 건수</p>
                  </div>
                  {historyRecords.length > 0 && !historyOpen && (
                    <span style={{ fontSize: 12, background: '#dcfce7', color: '#16a34a', border: '1px solid #bbf7d0', padding: '2px 10px', borderRadius: 999, fontWeight: 700 }}>
                      {historyRecords.length}건
                    </span>
                  )}
                  <span style={{ fontSize: 18, color: '#94a3b8', transform: historyOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>⌄</span>
                </div>

                {historyOpen && (
                  <div style={S.cardBody}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
                      <button
                        onClick={fetchHistory}
                        disabled={historyLoading}
                        style={{ fontSize: 12, padding: '5px 12px', borderRadius: 8, border: '1px solid #e2e8f0', color: '#475569', background: historyLoading ? '#f1f5f9' : 'white', cursor: historyLoading ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
                      >
                        {historyLoading ? '로딩...' : '↻ 새로고침'}
                      </button>
                    </div>

                    {historyLoading ? (
                      <p style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: '24px 0' }}>불러오는 중...</p>
                    ) : historyRecords.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '32px 0' }}>
                        <p style={{ fontSize: 28, marginBottom: 8 }}>📂</p>
                        <p style={{ fontSize: 13, color: '#94a3b8' }}>아직 분류 내역이 없습니다.</p>
                        <p style={{ fontSize: 12, color: '#cbd5e1', marginTop: 4 }}>자동 분류를 실행하면 여기에 기록됩니다.</p>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {historyRecords.map((rec, i) => {
                          const d   = new Date(rec.ts);
                          const pad = (n) => String(n).padStart(2, '0');
                          const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
                          const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
                          const providerInfo = { gmail: { label: 'Gmail', color: '#ea4335' }, naver: { label: '네이버', color: '#03c75a' }, nate: { label: '네이트', color: '#f04e36' }, cau: { label: 'CAU', color: '#0078d4' } };
                          const pInfo = providerInfo[rec.provider] || { label: rec.provider, color: '#64748b' };
                          return (
                            <div key={i} style={{ background: '#f8fafc', borderRadius: 14, border: '1px solid #e2e8f0', overflow: 'hidden', transition: 'box-shadow 0.2s' }}
                              onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.07)'}
                              onMouseLeave={(e) => e.currentTarget.style.boxShadow = 'none'}
                            >
                              {/* 헤더 행 */}
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'white', borderBottom: '1px solid #f1f5f9', gap: 12, flexWrap: 'wrap' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: pInfo.color + '18', color: pInfo.color, border: `1px solid ${pInfo.color}40` }}>{pInfo.label}</span>
                                  <span style={{ fontSize: 12, color: '#475569', fontWeight: 600 }}>{dateStr}</span>
                                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{timeStr}</span>
                                </div>
                                <span style={{ fontSize: 13, fontWeight: 800, color: '#2563eb', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '2px 10px', borderRadius: 999 }}>총 {rec.total}개</span>
                              </div>

                              {/* 카테고리 바 */}
                              <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                                {rec.categories.map((cat) => {
                                  const pct = rec.total > 0 ? Math.round((cat.count / rec.total) * 100) : 0;
                                  return (
                                    <div key={cat.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                      <span style={{ fontSize: 12, color: '#475569', minWidth: 90, fontWeight: 600, flexShrink: 0 }}>{cat.name}</span>
                                      <div style={{ flex: 1, height: 6, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden' }}>
                                        <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, #3b82f6, #6366f1)', borderRadius: 999, transition: 'width 0.4s ease' }} />
                                      </div>
                                      <span style={{ fontSize: 12, color: '#64748b', minWidth: 36, textAlign: 'right', fontWeight: 700 }}>{cat.count}개</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

            </div>
          )}
        </main>
      </div>

      <Toast toast={toast} />
    </div>
  );
}
