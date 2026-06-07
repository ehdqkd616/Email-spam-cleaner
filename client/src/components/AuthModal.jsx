import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { PROVIDERS } from '../lib/utils';
import Button from './Button';

export default function AuthModal({ provider, onClose, onSuccess, onError }) {
  const [user, setUser]       = useState('');
  const [pass, setPass]       = useState('');
  const [loading, setLoading] = useState(false);
  const [cauInfo, setCauInfo] = useState(null);
  const [copied, setCopied]   = useState(false);
  const info                  = PROVIDERS[provider];

  useEffect(() => {
    if (provider !== 'cau') return;
    (async () => {
      setLoading(true);
      try {
        const data = await api.startCauAuth();
        setCauInfo(data);
        const iv = setInterval(async () => {
          const result = await api.pollCauAuth();
          if (result.status === 'done')  { clearInterval(iv); onSuccess(); }
          if (result.status === 'error') { clearInterval(iv); onError(result.error || '인증 실패'); onClose(); }
        }, 3000);
      } catch (err) { onError(err.message); onClose(); }
      finally { setLoading(false); }
    })();
  }, [provider]);

  function handleBackdrop(e) {
    // 바깥 클릭해도 닫히지 않음
  }

  async function copyCode() {
    if (!cauInfo?.userCode) return;
    await navigator.clipboard.writeText(cauInfo.userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.connectImap({ provider, user, password: pass });
      onSuccess();
    } catch (err) {
      onError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '12px 16px',
    background: '#f8fafc',
    border: '1.5px solid #e2e8f0',
    borderRadius: 12,
    fontSize: 14,
    color: '#1e293b',
    outline: 'none',
    transition: 'all 0.15s ease',
    boxSizing: 'border-box',
  };

  return (
    <div
      onClick={handleBackdrop}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: 16,
      }}
    >
      <div style={{
        background: 'white',
        borderRadius: 24,
        boxShadow: '0 24px 64px rgba(0,0,0,0.18)',
        width: '100%',
        maxWidth: 440,
        overflow: 'hidden',
      }}>

        {/* 헤더 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px',
          borderBottom: '1px solid #f1f5f9',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12,
              background: '#f8fafc', border: '1px solid #e2e8f0',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22,
            }}>
              {info.icon}
            </div>
            <div>
              <p style={{ fontWeight: 800, color: '#1e293b', fontSize: 16 }}>{info.label} 연결</p>
              <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>인증 정보를 입력해주세요</p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32, height: 32, borderRadius: 8,
              border: '1px solid #e2e8f0', background: 'white',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, color: '#94a3b8',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc'; e.currentTarget.style.color = '#475569'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; e.currentTarget.style.color = '#94a3b8'; }}
          >
            ✕
          </button>
        </div>

        {/* 본문 */}
        <div style={{ padding: '24px 24px 28px' }}>

          {/* CAU 기기 코드 */}
          {provider === 'cau' && (
            <div style={{ textAlign: 'center' }}>
              {loading && !cauInfo ? (
                <div style={{ padding: '40px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 32, height: 32, border: '3px solid #bfdbfe', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <p style={{ fontSize: 13, color: '#94a3b8' }}>코드 생성 중...</p>
                </div>
              ) : cauInfo && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <p style={{ fontSize: 14, color: '#475569', lineHeight: 1.6 }}>아래 주소에 접속 후 코드를 입력하세요.</p>
                  <a href={cauInfo.verificationUri} target="_blank" rel="noreferrer"
                    style={{ fontSize: 13, color: '#2563eb', fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: 3 }}>
                    {cauInfo.verificationUri} ↗
                  </a>
                  <div style={{ position: 'relative', background: 'linear-gradient(135deg, #f8fafc, #eff6ff)', border: '1.5px solid #bfdbfe', borderRadius: 16, padding: '24px 32px' }}>
                    <p style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>인증 코드</p>
                    <p style={{ fontSize: 38, fontWeight: 900, letterSpacing: '0.3em', color: '#1e293b' }}>{cauInfo.userCode}</p>
                    <button onClick={copyCode}
                      style={{ position: 'absolute', top: 10, right: 10, padding: '4px 10px', background: copied ? '#dcfce7' : 'white', border: `1px solid ${copied ? '#bbf7d0' : '#e2e8f0'}`, borderRadius: 8, fontSize: 11, color: copied ? '#16a34a' : '#64748b', cursor: 'pointer', fontWeight: 600, transition: 'all 0.15s' }}>
                      {copied ? '✓ 복사됨' : '복사'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#94a3b8', fontSize: 13 }}>
                    {[0,1,2].map((i) => (
                      <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: '#93c5fd', animation: `bounce 1s ${i*0.15}s infinite` }} />
                    ))}
                    인증 완료를 기다리는 중...
                  </div>
                </div>
              )}
            </div>
          )}

          {/* IMAP 로그인 폼 */}
          {(provider === 'naver' || provider === 'nate') && (
            <form onSubmit={handleSubmit}>
              {/* 아이디 */}
              <div style={{ marginBottom: 18 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
                  아이디
                </label>
                <input
                  type="text"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder={provider === 'naver' ? 'naver_id' : 'nate@nate.com'}
                  required
                  style={inputStyle}
                  onFocus={(e) => { e.target.style.borderColor = '#3b82f6'; e.target.style.background = 'white'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.1)'; }}
                  onBlur={(e) => { e.target.style.borderColor = '#e2e8f0'; e.target.style.background = '#f8fafc'; e.target.style.boxShadow = 'none'; }}
                  onMouseEnter={(e) => { if (document.activeElement !== e.target) e.target.style.borderColor = '#cbd5e1'; }}
                  onMouseLeave={(e) => { if (document.activeElement !== e.target) e.target.style.borderColor = '#e2e8f0'; }}
                />
              </div>

              {/* 비밀번호 */}
              <div style={{ marginBottom: provider === 'naver' ? 14 : 24 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
                  비밀번호
                  {provider === 'naver' && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>앱 비밀번호 권장</span>
                  )}
                </label>
                <input
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder="••••••••"
                  required
                  style={inputStyle}
                  onFocus={(e) => { e.target.style.borderColor = '#3b82f6'; e.target.style.background = 'white'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.1)'; }}
                  onBlur={(e) => { e.target.style.borderColor = '#e2e8f0'; e.target.style.background = '#f8fafc'; e.target.style.boxShadow = 'none'; }}
                  onMouseEnter={(e) => { if (document.activeElement !== e.target) e.target.style.borderColor = '#cbd5e1'; }}
                  onMouseLeave={(e) => { if (document.activeElement !== e.target) e.target.style.borderColor = '#e2e8f0'; }}
                />
              </div>

              {/* Naver 경고 */}
              {provider === 'naver' && (
                <div style={{ display: 'flex', gap: 10, padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, marginBottom: 24 }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                  <p style={{ fontSize: 12, color: '#92400e', lineHeight: 1.6 }}>
                    일반 비밀번호 대신 <strong>앱 비밀번호</strong>를 사용하세요.<br />
                    nid.naver.com → 보안설정 → 앱 비밀번호
                  </p>
                </div>
              )}

              <Button type="submit" variant="primary" size="md" loading={loading} fullWidth>
                연결하기
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
