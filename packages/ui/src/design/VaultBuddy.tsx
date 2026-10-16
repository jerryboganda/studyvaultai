// "Vault buddy": an original round safe with a door for a face. In-house SVG on a 120x120 grid;
// thick strokes keep it readable at 32px. Colours come from the --sv-buddy-* tokens via classes
// (f- fill, s- stroke) in components.css; motion is finite and off under reduced motion.

export type BuddyPose = 'wave' | 'cheer' | 'think' | 'sleep';

function Arm({ d, hand, className }: { d: string; hand: [number, number]; className?: string }) {
  return (
    <g className={className}>
      <path d={d} className="s-navy" fill="none" strokeWidth={11} strokeLinecap="round" />
      <path d={d} className="s-body" fill="none" strokeWidth={5} strokeLinecap="round" />
      <circle cx={hand[0]} cy={hand[1]} r={7.5} className="f-sun s-navy" strokeWidth={3.5} />
    </g>
  );
}

function Eyes({ pose }: { pose: BuddyPose }) {
  if (pose === 'cheer' || pose === 'sleep') {
    const d =
      pose === 'cheer'
        ? ['M43 52 q6 -9 12 0', 'M69 52 q6 -9 12 0']
        : ['M43 49 q6 7 12 0', 'M69 49 q6 7 12 0'];
    return (
      <g className="s-ink" fill="none" strokeWidth={4.5} strokeLinecap="round">
        <path d={d[0]} />
        <path d={d[1]} />
      </g>
    );
  }
  const dx = pose === 'think' ? -2.5 : 0;
  const dy = pose === 'think' ? -3 : 0;
  return (
    <g>
      <ellipse cx={49} cy={50} rx={5.5} ry={6.5} className="f-ink" />
      <ellipse cx={75} cy={50} rx={5.5} ry={6.5} className="f-ink" />
      <circle cx={51 + dx} cy={47.5 + dy} r={2} className="f-white" />
      <circle cx={77 + dx} cy={47.5 + dy} r={2} className="f-white" />
    </g>
  );
}

// The keyhole sits mid-face like a nose; the mouth carries the mood.
function Mouth({ pose }: { pose: BuddyPose }) {
  if (pose === 'think') {
    return (
      <path
        d="M56 77 q3 -3 6 0 t6 0"
        className="s-ink"
        fill="none"
        strokeWidth={3.5}
        strokeLinecap="round"
      />
    );
  }
  if (pose === 'sleep') return <ellipse cx={62} cy={77} rx={2.8} ry={3.3} className="f-ink" />;
  const wide = pose === 'cheer';
  return (
    <g>
      <path
        d={wide ? 'M50 71 Q62 89 74 71 Z' : 'M54 72 Q62 84 70 72 Z'}
        className="f-ink s-ink"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <path
        d={
          wide
            ? 'M56 79.5 Q62 75.5 68 79.5 Q62 84 56 79.5 Z'
            : 'M58 77.2 Q62 75 66 77.2 Q62 80 58 77.2 Z'
        }
        className="f-cheek"
      />
    </g>
  );
}

export type VaultBuddyProps = {
  pose?: BuddyPose;
  /** Rendered width and height in px. */
  size?: number;
  /** Give a title only when the mascot carries meaning; without one it is decorative. */
  title?: string;
  className?: string;
};

export function VaultBuddy({ pose = 'wave', size = 96, title, className }: VaultBuddyProps) {
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const };
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={`sv-buddy sv-buddy--${pose}${className ? ` ${className}` : ''}`}
      focusable="false"
      {...a11y}
    >
      <ellipse cx={60} cy={113} rx={30} ry={4.5} className="f-ink sv-buddy__shadow" />
      <g className="sv-buddy__body">
        <rect x={36} y={96} width={18} height={14} rx={7} className="f-navy" />
        <rect x={66} y={96} width={18} height={14} rx={7} className="f-navy" />
        {pose === 'sleep' && (
          <>
            <Arm d="M22 72 Q14 82 16 92" hand={[16, 93]} />
            <Arm d="M98 72 Q106 82 104 92" hand={[104, 93]} />
          </>
        )}
        <rect
          x={16}
          y={20}
          width={88}
          height={82}
          rx={28}
          className="f-body s-navy"
          strokeWidth={4}
        />
        <path
          d="M30 30 Q60 22 90 30"
          className="s-shine"
          fill="none"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <rect
          x={11}
          y={40}
          width={9}
          height={14}
          rx={3.5}
          className="f-sun s-navy"
          strokeWidth={3}
        />
        <rect
          x={11}
          y={70}
          width={9}
          height={14}
          rx={3.5}
          className="f-sun s-navy"
          strokeWidth={3}
        />
        <circle cx={62} cy={60} r={31} className="f-door s-sun" strokeWidth={6} />
        <circle cx={62} cy={60} r={34.5} className="s-navy" fill="none" strokeWidth={2.5} />
        <ellipse cx={42} cy={64} rx={5.5} ry={3.5} className="f-cheek sv-buddy__blush" />
        <ellipse cx={82} cy={64} rx={5.5} ry={3.5} className="f-cheek sv-buddy__blush" />
        <Eyes pose={pose} />
        <g className="f-ink">
          <circle cx={62} cy={60.5} r={3.6} />
          <path d="M60.1 61.6 h3.8 l1.1 5.4 q-3 1.1 -6 0 z" />
        </g>
        <Mouth pose={pose} />
        {pose === 'wave' && (
          <>
            <Arm d="M22 74 Q12 82 12 92" hand={[12, 93]} />
            <Arm className="sv-buddy__wave" d="M99 66 Q110 54 108 38" hand={[108, 36]} />
          </>
        )}
        {pose === 'cheer' && (
          <>
            <Arm d="M21 64 Q8 52 10 34" hand={[10, 32]} />
            <Arm d="M99 64 Q112 52 110 34" hand={[110, 32]} />
          </>
        )}
        {pose === 'think' && (
          <>
            <Arm d="M22 74 Q12 82 12 92" hand={[12, 93]} />
            <Arm d="M100 74 Q106 94 80 88" hand={[78, 87]} />
          </>
        )}
      </g>
      {pose === 'cheer' && (
        <g className="sv-buddy__sparks f-sun s-navy" strokeWidth={2}>
          <path d="M60 2 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z" />
          <path d="M24 8 l2 4 4 2 -4 2 -2 4 -2 -4 -4 -2 4 -2z" />
          <path d="M96 8 l2 4 4 2 -4 2 -2 4 -2 -4 -4 -2 4 -2z" />
        </g>
      )}
      {pose === 'think' && (
        <g className="sv-buddy__dots f-door s-navy" strokeWidth={2.5}>
          <circle cx={92} cy={16} r={4} />
          <circle cx={103} cy={8} r={5.5} />
          <circle cx={84} cy={22} r={2.5} />
        </g>
      )}
      {pose === 'sleep' && (
        <g
          className="sv-buddy__zzz"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M88 6 h10 l-10 11 h10" />
          <path d="M104 18 h7 l-7 8 h7" />
        </g>
      )}
    </svg>
  );
}
