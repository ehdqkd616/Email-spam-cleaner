import { useEffect, useState } from 'react';

export default function Toast({ toast }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(!!toast);
  }, [toast]);

  if (!toast) return null;

  const isError = toast.type === 'error';

  return (
    <div
      className={visible ? 'toast-enter' : 'toast-exit'}
      style={{
        position: 'fixed',
        bottom: 28,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        paddingTop: 16,
        paddingBottom: 16,
        paddingLeft: 24,
        paddingRight: 24,
        borderRadius: 16,
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        color: 'white',
        fontSize: 14,
        fontWeight: 700,
        minWidth: 260,
        maxWidth: 420,
        background: isError
          ? 'linear-gradient(135deg, #ef4444, #e11d48)'
          : 'linear-gradient(135deg, #10b981, #0d9488)',
      }}
    >
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        background: 'rgba(255,255,255,0.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, fontSize: 13, fontWeight: 900,
      }}>
        {isError ? '✕' : '✓'}
      </div>
      <span style={{ flex: 1 }}>{toast.message}</span>
    </div>
  );
}
