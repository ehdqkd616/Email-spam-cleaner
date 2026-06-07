import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export const PROVIDERS = {
  gmail: { label: 'Gmail',       icon: '📧', color: 'bg-red-50 border-red-200',    badge: 'bg-red-100 text-red-700' },
  naver: { label: 'Naver Mail',  icon: '🟢', color: 'bg-green-50 border-green-200', badge: 'bg-green-100 text-green-700' },
  nate:  { label: 'Nate Mail',   icon: '🔵', color: 'bg-blue-50 border-blue-200',   badge: 'bg-blue-100 text-blue-700' },
  cau:   { label: '중앙대 (CAU)', icon: '🏫', color: 'bg-purple-50 border-purple-200', badge: 'bg-purple-100 text-purple-700' },
};
