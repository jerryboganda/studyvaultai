// Vault buddy, Night Arcade cut: a round vault door with marquee-light bolts and a keyhole mouth.
// In-house SVG. Readable from 32px (silhouette, eyes, keyhole) up to 160px (bolts, sparkles).
export type BuddyPose = 'wave' | 'cheer' | 'think' | 'sleep';

const INK = '#120d33';
const BODY = '#6b4bff';
const DOOR = '#8a72ff';
const LIME = '#c6ff3d';
const PINK = '#ff4fa3';

const BOLTS = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
  return { x: 60 + Math.cos(a) * 36.5, y: 62 + Math.sin(a) * 36.5 };
});

function Arm({ d, className }: { d: string; className?: string }) {
  return (
    <g className={className}>
      <path d={d} fill="none" stroke={INK} strokeWidth={16} strokeLinecap="round" />
      <path d={d} fill="none" stroke={BODY} strokeWidth={9} strokeLinecap="round" />
    </g>
  );
}

function Spark({ x, y, s, fill }: { x: number; y: number; s: number; fill: string }) {
  return (
    <path
      className="vb-spark"
      d={`M${x} ${y - s} Q${x} ${y} ${x + s} ${y} Q${x} ${y} ${x} ${y + s} Q${x} ${y} ${x - s} ${y} Q${x} ${y} ${x} ${y - s}Z`}
      fill={fill}
      stroke={INK}
      strokeWidth={1.5}
      strokeLinejoin="round"
    />
  );
}

function Eyes({ pose }: { pose: BuddyPose }) {
  if (pose === 'cheer') {
    return (
      <g fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round">
        <path d="M42 59 Q48 50 54 59" />
        <path d="M66 59 Q72 50 78 59" />
      </g>
    );
  }
  if (pose === 'sleep') {
    return (
      <g fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round">
        <path d="M42 57 Q48 63 54 57" />
        <path d="M66 57 Q72 63 78 57" />
      </g>
    );
  }
  const dx = pose === 'think' ? 2.5 : 0;
  const dy = pose === 'think' ? -2.5 : 0;
  return (
    <g className="vb-eyes">
      <ellipse cx={48 + dx} cy={56 + dy} rx={5} ry={6.5} fill={INK} />
      <ellipse cx={72 + dx} cy={56 + dy} rx={5} ry={6.5} fill={INK} />
      <circle cx={49.6 + dx} cy={53.4 + dy} r={1.9} fill="#fff" />
      <circle cx={73.6 + dx} cy={53.4 + dy} r={1.9} fill="#fff" />
      {pose === 'think' && (
        <path
          d="M66 44 Q73 40 79 44"
          fill="none"
          stroke={INK}
          strokeWidth={3}
          strokeLinecap="round"
        />
      )}
    </g>
  );
}

export function VaultBuddy({
  pose = 'wave',
  size = 120,
  label,
  className,
}: {
  pose?: BuddyPose;
  size?: number;
  /** Omit for a decorative buddy (hidden from assistive tech). */
  label?: string;
  className?: string;
}) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  const dim = pose === 'sleep';
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={`vb vb-${pose}${className ? ` ${className}` : ''}`}
      focusable="false"
      {...a11y}
    >
      <ellipse cx={60} cy={113} rx={28} ry={4} fill={INK} opacity={0.22} />
      {/* Arms sit behind the body so the silhouette stays round. */}
      {pose === 'wave' && (
        <>
          <Arm d="M26 74 Q18 84 22 94" />
          <Arm d="M94 66 Q106 52 104 36" className="vb-wave-arm" />
        </>
      )}
      {pose === 'cheer' && (
        <>
          <Arm d="M28 62 Q14 48 16 32" />
          <Arm d="M92 62 Q106 48 104 32" />
        </>
      )}
      {pose === 'think' && (
        <>
          <Arm d="M26 74 Q18 84 22 94" />
          <Arm d="M94 74 Q100 92 82 92" />
        </>
      )}
      {pose === 'sleep' && (
        <>
          <Arm d="M28 80 Q24 90 32 96" />
          <Arm d="M92 80 Q96 90 88 96" />
        </>
      )}
      <g className="vb-body">
        <rect x={38} y={96} width={16} height={12} rx={6} fill={INK} />
        <rect x={66} y={96} width={16} height={12} rx={6} fill={INK} />
        <circle cx={60} cy={62} r={44} fill={BODY} stroke={INK} strokeWidth={4} />
        <path
          d="M28 48 A36 36 0 0 1 60 24"
          fill="none"
          stroke="#fff"
          strokeOpacity={0.35}
          strokeWidth={5}
          strokeLinecap="round"
        />
        <circle cx={60} cy={62} r={30} fill={DOOR} stroke={INK} strokeWidth={3} />
        {BOLTS.map((b, i) => (
          <circle
            key={i}
            className={i % 2 ? 'vb-bolt vb-bolt-b' : 'vb-bolt'}
            cx={b.x}
            cy={b.y}
            r={3}
            fill={pose === 'cheer' && i % 2 ? PINK : LIME}
            stroke={INK}
            strokeWidth={1.5}
            opacity={dim ? 0.45 : 1}
          />
        ))}
        <Eyes pose={pose} />
        <ellipse cx={41} cy={68} rx={5} ry={3} fill={PINK} opacity={0.85} />
        <ellipse cx={79} cy={68} rx={5} ry={3} fill={PINK} opacity={0.85} />
        {/* The keyhole is the mouth: the one feature every pose keeps. */}
        <circle cx={60} cy={71} r={5.5} fill={INK} />
        <path d="M56.6 73 L63.4 73 L65.6 85 L54.4 85 Z" fill={INK} strokeLinejoin="round" />
      </g>
      {pose === 'cheer' && (
        <>
          <Spark x={14} y={18} s={7} fill={LIME} />
          <Spark x={106} y={16} s={6} fill={PINK} />
          <Spark x={110} y={88} s={4.5} fill={LIME} />
        </>
      )}
      {pose === 'wave' && <Spark x={112} y={22} s={5} fill={LIME} />}
      {pose === 'think' && (
        <g className="vb-dots" fill={LIME} stroke={INK} strokeWidth={1.5}>
          <circle cx={92} cy={24} r={3} />
          <circle cx={102} cy={15} r={4.2} />
          <circle cx={113} cy={6.5} r={5.2} />
        </g>
      )}
      {pose === 'sleep' && (
        <g
          className="vb-z"
          fill={LIME}
          stroke={INK}
          strokeWidth={1.4}
          fontFamily="system-ui, sans-serif"
          fontWeight={900}
          paintOrder="stroke"
        >
          <text x={88} y={30} fontSize={18}>
            z
          </text>
          <text x={101} y={16} fontSize={13}>
            z
          </text>
        </g>
      )}
    </svg>
  );
}
