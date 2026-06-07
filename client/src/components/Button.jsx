import { useState } from 'react';
import { cn } from '../lib/utils';

const VARIANTS = {
  primary: 'bg-slate-900 hover:bg-slate-800 text-white shadow-sm hover:shadow-md',
  blue:    'bg-blue-600 hover:bg-blue-500 text-white shadow-sm hover:shadow-md hover:shadow-blue-200',
  danger:  'bg-red-500 hover:bg-red-400 text-white shadow-sm hover:shadow-md hover:shadow-red-200',
  amber:   'bg-amber-500 hover:bg-amber-400 text-white shadow-sm hover:shadow-md hover:shadow-amber-200',
  orange:  'bg-orange-500 hover:bg-orange-400 text-white shadow-sm hover:shadow-md hover:shadow-orange-200',
  ghost:   'bg-transparent hover:bg-slate-100 text-slate-600',
  outline: 'border border-slate-200 hover:border-blue-300 hover:bg-blue-50 text-slate-600 hover:text-blue-600 bg-white',
  success: 'bg-emerald-500 hover:bg-emerald-400 text-white shadow-sm hover:shadow-md hover:shadow-emerald-200',
};

const SIZES = {
  xs: 'text-xs rounded-lg',
  sm: 'text-sm rounded-xl',
  md: 'text-sm rounded-xl',
  lg: 'text-base rounded-xl',
  xl: 'text-base rounded-2xl',
};

const PADDING = {
  xs: { y: 10, x: 16 },
  sm: { y: 14, x: 24 },
  md: { y: 18, x: 28 },
  lg: { y: 20, x: 32 },
  xl: { y: 24, x: 40 },
};

export default function Button({
  children,
  onClick,
  className,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  type = 'button',
  darkRipple = false,
  fullWidth = false,
  ...props
}) {
  const [ripples, setRipples] = useState([]);

  function handleClick(e) {
    if (disabled || loading) return;

    // 리플 생성
    const btn  = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const diameter = Math.max(rect.width, rect.height) * 2;
    const x = e.clientX - rect.left - diameter / 2;
    const y = e.clientY - rect.top  - diameter / 2;
    const id = Date.now() + Math.random();

    setRipples((prev) => [...prev, { x, y, size: diameter, id }]);
    setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 700);

    onClick?.(e);
  }

  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={handleClick}
      style={{
        paddingTop:    PADDING[size].y,
        paddingBottom: PADDING[size].y,
        paddingLeft:   PADDING[size].x,
        paddingRight:  PADDING[size].x,
      }}
      className={cn(
        'relative overflow-hidden font-semibold select-none',
        'transition-all duration-150 ease-out',
        'cursor-pointer hover:-translate-y-px',
        'active:translate-y-0 active:scale-[0.96]',
        'disabled:opacity-50 disabled:!cursor-not-allowed disabled:!translate-y-0 disabled:!scale-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className
      )}
      {...props}
    >
      {/* 로딩 스피너 */}
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin opacity-80" />
          {typeof children === 'string' ? children : '처리 중...'}
        </span>
      ) : children}

      {/* 리플 레이어 */}
      {ripples.map(({ x, y, size, id }) => (
        <span
          key={id}
          className={cn('ripple', darkRipple && 'ripple-dark')}
          style={{ left: x, top: y, width: size, height: size }}
        />
      ))}
    </button>
  );
}
