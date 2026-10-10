/** Stroke icons, sized by the caller. Decorative unless given a title. */

interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function MarkIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <path d="M4 20V8.5a4.5 4.5 0 0 1 9 0V20" />
      <path d="M13 20V8.5a4.5 4.5 0 0 1 7 3.5V20" />
    </svg>
  );
}

export function CheckIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={3}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function SpecialistIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.9}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function ArrowIcon({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.1}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export function DownloadIcon({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

export function PersonIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
