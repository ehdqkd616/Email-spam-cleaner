import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { PROVIDERS } from '../lib/utils';
import ProviderCard from '../components/ProviderCard';
import AuthModal from '../components/AuthModal';
import Button from '../components/Button';
import Toast from '../components/Toast';

export default function Home() {
  const [status, setStatus]     = useState({});
  const [activeModal, setModal] = useState(null);
  const [toast, setToast]       = useState(null);
  const [params]                = useSearchParams();
  const navigate                = useNavigate();

  async function loadStatus() {
    try { setStatus(await api.getStatus()); } catch (_) {}
  }

  useEffect(() => {
    loadStatus();
    const provider = params.get('provider');
    const st = params.get('status');
    if (provider && st === 'success') { showToast(`${PROVIDERS[provider]?.label} 연결 완료!`); loadStatus(); }
    else if (provider && st === 'error') showToast(params.get('msg') || '연결 실패', 'error');
  }, []);

  function showToast(message, type = 'success') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }

  async function handleConnect(provider) {
    if (provider === 'gmail') {
      try { const { authUrl } = await api.startGmailAuth(); window.location.href = authUrl; }
      catch (err) { showToast(err.message, 'error'); }
    } else { setModal(provider); }
  }

  async function handleDisconnect(provider) {
    await api.disconnect(provider);
    loadStatus();
    showToast(`${PROVIDERS[provider].label} 연결 해제됨`);
  }

  const anyConnected   = Object.values(status).some((s) => s?.connected);
  const connectedCount = Object.values(status).filter((s) => s?.connected).length;

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 50%, #f0e8ff 100%)' }}>

      {/* ── 헤더 ── */}
      <header style={{ background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(226,232,240,0.8)', position: 'sticky', top: 0, zIndex: 40 }}>
        <div style={{ maxWidth: 1280, margin: '0 auto', padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg, #3b82f6, #6366f1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: 'white', boxShadow: '0 2px 8px rgba(99,102,241,0.3)' }}>✉</div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 18, color: '#1e293b', lineHeight: 1.2 }}>Mail Cleaner</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>이메일 광고·스팸 자동 정리</div>
            </div>
          </div>
          {anyConnected && (
            <Button variant="blue" size="sm" onClick={() => navigate('/dashboard')}>
              대시보드 →
            </Button>
          )}
        </div>
      </header>

      {/* ── 히어로 ── */}
      <section style={{ padding: '72px 32px 48px', textAlign: 'center' }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: 999, marginBottom: 24 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#3b82f6', display: 'inline-block', animation: 'pulse 2s infinite' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#2563eb' }}>
              {connectedCount > 0 ? `${connectedCount}개 서비스 연결됨` : '서비스를 연결해 시작하세요'}
            </span>
          </div>
          <h1 style={{ fontSize: 'clamp(32px, 5vw, 52px)', fontWeight: 800, color: '#0f172a', lineHeight: 1.2, letterSpacing: '-1px', marginBottom: 20 }}>
            이메일을 깔끔하게<br />정리하세요
          </h1>
          <p style={{ fontSize: 'clamp(15px, 2vw, 18px)', color: '#64748b', lineHeight: 1.7, marginBottom: 0 }}>
            Gmail, 네이버, 네이트 메일의 광고·스팸을<br />한 번에 스캔하고 정리합니다.
          </p>
        </div>
      </section>

      {/* ── 카드 그리드 ── */}
      <section style={{ padding: '0 32px 80px' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 20,
          }}>
            {Object.entries(PROVIDERS).map(([key, info], i) => (
              <div key={key} style={{ animationDelay: `${i * 0.08}s` }}>
                <ProviderCard
                  providerKey={key}
                  info={info}
                  status={status[key]}
                  onConnect={() => handleConnect(key)}
                  onDisconnect={() => handleDisconnect(key)}
                  onManage={() => navigate('/dashboard', { state: { provider: key } })}
                />
              </div>
            ))}
          </div>

          {anyConnected && (
            <div style={{ marginTop: 48, textAlign: 'center' }}>
              <Button variant="primary" size="xl" onClick={() => navigate('/dashboard')} className="shadow-lg hover:shadow-xl">
                메일 정리 시작하기 →
              </Button>
              <p style={{ marginTop: 12, fontSize: 13, color: '#94a3b8' }}>연결된 모든 서비스를 한 화면에서 관리</p>
            </div>
          )}
        </div>
      </section>

      {activeModal && (
        <AuthModal
          provider={activeModal}
          onClose={() => setModal(null)}
          onSuccess={() => { setModal(null); loadStatus(); showToast(`${PROVIDERS[activeModal].label} 연결 완료!`); }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}
      <Toast toast={toast} />
    </div>
  );
}
