import { cn } from '../lib/utils';
import Button from './Button';
import { PROVIDER_LOGOS } from './ProviderLogo';

const DESCRIPTIONS = {
  gmail: 'Google OAuth2로 안전하게 인증',
  naver: 'IMAP + 앱 비밀번호로 연결',
  nate:  'IMAP 아이디/비밀번호로 연결',
  cau:   'Microsoft 기기 코드 인증 (관리자 승인 필요)',
};

const ICON_STYLE = {
  gmail: { background: '#fef2f2', border: '1px solid #fecaca' },
  naver: { background: '#f0fdf4', border: '1px solid #bbf7d0' },
  nate:  { background: '#eff6ff', border: '1px solid #bfdbfe' },
  cau:   { background: '#faf5ff', border: '1px solid #e9d5ff' },
};

const RING_STYLE = {
  gmail: '0 0 0 2px #fecaca',
  naver: '0 0 0 2px #bbf7d0',
  nate:  '0 0 0 2px #bfdbfe',
  cau:   '0 0 0 2px #e9d5ff',
};

export default function ProviderCard({ providerKey, info, status, onConnect, onDisconnect, onManage }) {
  const connected = status?.connected;
  const Logo = PROVIDER_LOGOS[providerKey];

  return (
    <div
      className="group"
      style={{
        background: 'white',
        borderRadius: 20,
        border: '1px solid #e2e8f0',
        padding: '28px 24px 24px',
        boxShadow: connected
          ? `0 4px 20px rgba(0,0,0,0.08), ${RING_STYLE[providerKey]}`
          : '0 2px 8px rgba(0,0,0,0.04)',
        transition: 'all 0.2s ease',
        cursor: 'default',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 220,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-4px)';
        e.currentTarget.style.boxShadow = connected
          ? `0 12px 32px rgba(0,0,0,0.12), ${RING_STYLE[providerKey]}`
          : '0 12px 32px rgba(0,0,0,0.10)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = connected
          ? `0 4px 20px rgba(0,0,0,0.08), ${RING_STYLE[providerKey]}`
          : '0 2px 8px rgba(0,0,0,0.04)';
      }}
    >
      {/* 연결됨 뱃지 */}
      {connected && (
        <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 999 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'pulse 2s infinite' }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a' }}>연결됨</span>
        </div>
      )}

      {/* 아이콘 */}
      <div
        style={{
          width: 52, height: 52, borderRadius: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 16,
          transition: 'transform 0.2s ease',
          ...ICON_STYLE[providerKey],
        }}
        className="group-hover:[transform:scale(1.12)_rotate(4deg)]"
      >
        {Logo ? <Logo size={30} /> : info.icon}
      </div>

      {/* 텍스트 */}
      <div style={{ marginBottom: 20, flex: 1 }}>
        <h3 style={{ fontWeight: 700, fontSize: 16, color: '#1e293b', marginBottom: 6 }}>{info.label}</h3>
        {connected
          ? <p style={{ fontSize: 12, color: '#64748b', wordBreak: 'break-all' }}>{status.email}</p>
          : <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5 }}>{DESCRIPTIONS[providerKey]}</p>
        }
      </div>

      {/* 버튼 */}
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        {connected ? (
          <>
            <Button variant="primary" size="md" onClick={onManage} fullWidth className="flex-1">
              메일 관리 →
            </Button>
            <Button
              variant="outline"
              size="md"
              onClick={onDisconnect}
              darkRipple
              className="hover:!border-red-300 hover:!bg-red-50 hover:!text-red-500"
              style={{ padding: '0 14px' }}
            >
              ✕
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="md"
            onClick={onConnect}
            disabled={providerKey === 'cau'}
            fullWidth
            className={providerKey === 'cau' ? '!opacity-40' : ''}
          >
            {providerKey === 'cau' ? '관리자 승인 필요' : '연결하기'}
          </Button>
        )}
      </div>
    </div>
  );
}
