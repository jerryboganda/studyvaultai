import { BarMeter } from './BarMeter';

export type StepperProps = {
  /** Step titles (<= 3 words each); the current one is read with the progress. */
  steps: string[];
  /** Zero-based index of the current step. */
  current: number;
  /** Name of the flow, e.g. "New bank". */
  label: string;
};

/** Wizard progress (Sunny / UX_DESIGN 6.9): one bar plus "2/4", read as "Step 2 of 4: Pick an icon". */
export function Stepper({ steps, current, label }: StepperProps) {
  const n = current + 1;
  return (
    <div className="sv-stepper">
      <BarMeter
        value={n}
        max={steps.length}
        label={`${label} progress`}
        valueText={`Step ${n} of ${steps.length}: ${steps[current] ?? ''}`}
        tone="primary"
      />
      <span className="sv-stepper__count" aria-hidden="true">
        {n}/{steps.length}
      </span>
    </div>
  );
}
