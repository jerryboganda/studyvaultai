/**
 * The overlay's icons, inlined: the content script may not import @ui, and lucide-react's runtime
 * would cost more than these few paths. Path data is lucide 1.48.0 (ISC), sub-paths joined into one
 * `d` (every stroke is the same). Icons are decoration: the control carries the name.
 */
const PATHS = {
  bookmark:
    'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z',
  note: 'M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4M2 6h4M2 10h4M2 14h4M2 18h4M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z',
  chevron: 'm6 9 6 6 6-6',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11',
  zap: 'M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z',
  more: 'M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M18 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
  retry: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
  alert:
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01',
  info: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 16v-4M12 8h.01',
  trash:
    'M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  plus: 'M5 12h14M12 5v14',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, fill }: { name: IconName; size?: number; fill?: boolean }) {
  return (
    <svg
      className="sv-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The StudyVault logo mark (UX_DESIGN 3: web pages show the mark, never the mascot). Brand colours. */
export function LogoMark() {
  return (
    <svg className="sv-logo" viewBox="0 0 32 32" width={24} height={24} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#2a62e5" />
      <rect x="7" y="8" width="18" height="3" rx="1.5" fill="#fff" />
      <rect x="5.5" y="13.5" width="21" height="5" rx="2" fill="#ffc83d" />
      <rect x="8.5" y="15.2" width="15" height="1.6" rx="0.8" fill="#18213b" />
      <rect x="7" y="21" width="12" height="3" rx="1.5" fill="#fff" />
    </svg>
  );
}
