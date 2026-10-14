// Vault buddy, Candy Garden take: a round lavender safe whose door is the face (keyhole mouth),
// with a little sprout on top. In-house SVG, readable from 32px to 160px, light and dark.
export type Pose = 'wave' | 'cheer' | 'think' | 'sleep';

const LINE = 'var(--vb-line)';
const BODY = 'var(--vb-body)';

function Arm({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return (
    <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={LINE} strokeWidth={17} strokeLinecap="round" />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={BODY} strokeWidth={11} strokeLinecap="round" />
    </>
  );
}

function Spark({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <path
      className="vb-spark"
      transform={`translate(${x} ${y}) scale(${s})`}
      d="M0 -7 C1 -2 2 -1 7 0 C2 1 1 2 0 7 C-1 2 -2 1 -7 0 C-2 -1 -1 -2 0 -7 Z"
      fill="var(--vb-spark)"
    />
  );
}

export function VaultBuddy({
  pose = 'wave',
  size = 96,
  label,
  still = false,
}: {
  pose?: Pose;
  size?: number;
  label?: string;
  still?: boolean;
}) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <svg
      className="vb"
      data-pose={pose}
      data-still={still || undefined}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      focusable="false"
      {...a11y}
    >
      <ellipse cx="60" cy="113" rx="30" ry="4.5" fill="var(--vb-shadow)" />
      <g className="vb-body">
        {/* arms sit behind the body so the shoulders tuck in */}
        {pose === 'cheer' ? (
          <>
            <Arm x1={26} y1={62} x2={9} y2={38} />
            <Arm x1={94} y1={62} x2={111} y2={38} />
          </>
        ) : (
          <Arm x1={26} y1={72} x2={13} y2={88} />
        )}
        {pose === 'wave' && (
          <g className="vb-wave">
            <Arm x1={94} y1={64} x2={110} y2={40} />
          </g>
        )}
        {(pose === 'think' || pose === 'sleep') && <Arm x1={94} y1={72} x2={107} y2={88} />}

        {/* feet */}
        <rect
          x="36"
          y="96"
          width="17"
          height="13"
          rx="6.5"
          fill="var(--vb-body-2)"
          stroke={LINE}
          strokeWidth="3"
        />
        <rect
          x="67"
          y="96"
          width="17"
          height="13"
          rx="6.5"
          fill="var(--vb-body-2)"
          stroke={LINE}
          strokeWidth="3"
        />

        {/* sprout */}
        <g className="vb-sprout">
          <path
            d={pose === 'sleep' ? 'M60 26 C60 19 63 14 69 13' : 'M60 26 C60 20 60 17 61 12'}
            fill="none"
            stroke="var(--vb-leaf-line)"
            strokeWidth="3"
            strokeLinecap="round"
          />
          {/* asleep, the sprout bends over and both leaves hang from its tip */}
          <path
            d={
              pose === 'sleep'
                ? 'M68 14 C66 19 62 21 56 21 C58 16 63 13 68 14 Z'
                : 'M60 17 C52 17 47 12 46 5 C53 5 59 9 60 17 Z'
            }
            fill="var(--vb-leaf)"
            stroke="var(--vb-leaf-line)"
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
          <path
            d={
              pose === 'sleep'
                ? 'M69 13 C74 13 78 17 78 24 C73 23 69 19 69 13 Z'
                : 'M61 13 C67 8 74 8 79 11 C75 18 67 18 61 13 Z'
            }
            fill="var(--vb-leaf)"
            stroke="var(--vb-leaf-line)"
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
        </g>

        {/* the safe */}
        <rect
          x="18"
          y="24"
          width="84"
          height="80"
          rx="36"
          fill={BODY}
          stroke={LINE}
          strokeWidth="3.2"
        />
        <ellipse
          cx="36"
          cy="40"
          rx="9"
          ry="5"
          transform="rotate(-35 36 40)"
          fill="#fff"
          opacity="0.5"
        />
        <circle cx="29" cy="40" r="2.4" fill={LINE} opacity="0.45" />
        <circle cx="91" cy="40" r="2.4" fill={LINE} opacity="0.45" />
        <circle cx="29" cy="90" r="2.4" fill={LINE} opacity="0.45" />
        <circle cx="91" cy="90" r="2.4" fill={LINE} opacity="0.45" />

        {/* door = face */}
        <circle cx="60" cy="66" r="28" fill="var(--vb-plate)" stroke={LINE} strokeWidth="3" />
        <circle cx="60" cy="66" r="22.5" fill="none" stroke="var(--vb-ring)" strokeWidth="2.5" />
        <ellipse cx="44" cy="70" rx="4.6" ry="2.8" fill="var(--vb-cheek)" />
        <ellipse cx="76" cy="70" rx="4.6" ry="2.8" fill="var(--vb-cheek)" />

        {pose === 'cheer' && (
          <g fill="none" stroke={LINE} strokeWidth="3.2" strokeLinecap="round">
            <path d="M45.5 61 Q50 54.5 54.5 61" />
            <path d="M65.5 61 Q70 54.5 74.5 61" />
          </g>
        )}
        {pose === 'sleep' && (
          <g fill="none" stroke={LINE} strokeWidth="3" strokeLinecap="round">
            <path d="M45.5 59.5 Q50 64 54.5 59.5" />
            <path d="M65.5 59.5 Q70 64 74.5 59.5" />
          </g>
        )}
        {(pose === 'wave' || pose === 'think') && (
          <g className="vb-eyes">
            <ellipse
              cx={pose === 'think' ? 51.5 : 50}
              cy={pose === 'think' ? 58.5 : 60}
              rx="3.7"
              ry="4.7"
              fill={LINE}
            />
            <ellipse
              cx={pose === 'think' ? 71.5 : 70}
              cy={pose === 'think' ? 58.5 : 60}
              rx="3.7"
              ry="4.7"
              fill={LINE}
            />
            <circle
              cx={pose === 'think' ? 52.8 : 51.3}
              cy={pose === 'think' ? 56.8 : 58.3}
              r="1.4"
              fill="#fff"
            />
            <circle
              cx={pose === 'think' ? 72.8 : 71.3}
              cy={pose === 'think' ? 56.8 : 58.3}
              r="1.4"
              fill="#fff"
            />
          </g>
        )}

        {/* keyhole mouth: a light keyhole inside a grin when happy, a small keyhole "o" otherwise */}
        {pose === 'wave' || pose === 'cheer' ? (
          <g>
            <path
              d={
                pose === 'cheer'
                  ? 'M50 68 C55 70.2 65 70.2 70 68 C69.5 77.8 65.4 82.4 60 82.4 C54.6 82.4 50.5 77.8 50 68 Z'
                  : 'M52 69 C56 70.6 64 70.6 68 69 C67.6 76.6 64.4 80.2 60 80.2 C55.6 80.2 52.4 76.6 52 69 Z'
              }
              fill={LINE}
              stroke={LINE}
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <g fill="var(--vb-plate)">
              <circle cx="60" cy={pose === 'cheer' ? 72.6 : 72.4} r={pose === 'cheer' ? 2.7 : 2.3} />
              <path
                d={
                  pose === 'cheer'
                    ? 'M58.7 74 H61.3 L62.3 79.2 H57.7 Z'
                    : 'M58.9 73.6 H61.1 L62 77.8 H58 Z'
                }
              />
            </g>
          </g>
        ) : (
          <g fill={LINE}>
            <circle cx="60" cy="71" r={pose === 'sleep' ? 2.8 : 3.7} />
            <path
              d={
                pose === 'sleep'
                  ? 'M58.3 72.5 L61.7 72.5 L62.5 78 Q60 78.8 57.5 78 Z'
                  : 'M57.5 72 L62.5 72 L63.8 80 Q60 81.2 56.2 80 Z'
              }
            />
          </g>
        )}

        {pose === 'think' && (
          <>
            <circle cx="83" cy="84" r="7.5" fill={BODY} stroke={LINE} strokeWidth="3" />
            <g className="vb-bubbles" fill="var(--vb-plate)" stroke={LINE} strokeWidth="2.2">
              <circle cx="92" cy="22" r="2.6" />
              <circle cx="99.5" cy="13.5" r="3.6" />
              <circle cx="109" cy="6" r="4.4" />
            </g>
          </>
        )}
      </g>

      {pose === 'cheer' && (
        <g>
          <Spark x={14} y={18} />
          <Spark x={106} y={16} s={0.8} />
          <Spark x={8} y={64} s={0.6} />
          <Spark x={113} y={62} s={0.7} />
        </g>
      )}
      {pose === 'sleep' && (
        <g className="vb-z" fill="var(--sv-ink-3)" fontFamily="inherit" fontWeight="900">
          <text x="86" y="26" fontSize="15">
            z
          </text>
          <text x="98" y="15" fontSize="11">
            z
          </text>
        </g>
      )}
    </svg>
  );
}

/** Product mark: a rounded lavender vault with a keyhole and a leaf. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className="sv-logo"
    >
      <rect x="2" y="5" width="28" height="25" rx="11" fill="var(--sv-primary)" />
      <circle cx="16" cy="17.5" r="8" fill="var(--sv-surface)" />
      <circle cx="16" cy="16.3" r="2.3" fill="var(--sv-primary)" />
      <path d="M14.6 17.3 h2.8 l0.7 4.4 h-4.2 z" fill="var(--sv-primary)" />
      <path d="M16 5 C16 3 17 1.5 19.5 1 C19.5 3.4 18 4.8 16 5 Z" fill="var(--sv-mint-solid)" />
    </svg>
  );
}
