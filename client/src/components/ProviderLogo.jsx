export function GmailLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="52 42 88 66" xmlns="http://www.w3.org/2000/svg">
      <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6"/>
      <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15"/>
      <path fill="#fbbc04" d="M120 58v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2"/>
      <path fill="#ea4335" d="M72 84V58l24 18 24-18v26L96 102"/>
      <path fill="#c5221f" d="M52 61v8l20 15V58l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2"/>
    </svg>
  );
}

export function NaverLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16.273 12.845L7.376 0H0v24h7.727V11.155L16.624 24H24V0h-7.727z"
        fill="#03C75A"
      />
    </svg>
  );
}

export function NateLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" rx="18" fill="#E8202D"/>
      {/* 흰색 소문자 n */}
      <path
        d="M22 78 V30 Q22 18 50 18 Q78 18 78 42 V78 H62 V44 Q62 36 50 36 Q38 36 38 44 V78 Z"
        fill="white"
      />
    </svg>
  );
}

export function CAULogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" rx="18" fill="#003087"/>
      <text
        x="50" y="62"
        textAnchor="middle"
        fill="white"
        fontSize="32"
        fontFamily="Georgia, serif"
        fontWeight="bold"
      >
        CAU
      </text>
    </svg>
  );
}

export const PROVIDER_LOGOS = {
  gmail: GmailLogo,
  naver: NaverLogo,
  nate:  NateLogo,
  cau:   CAULogo,
};
