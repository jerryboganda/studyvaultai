/**
 * Sunny Vault component library for extension pages (React 19; also runs under preact/compat).
 * Pages load design/tokens.css + design/components.css and the bundled Nunito
 * (@fontsource-variable/nunito). Class names are chosen not to collide with the legacy
 * components.css, so both can load during the migration. The in-page overlay must not import
 * this barrel (@ui); it may only share tokens.css inside its shadow root.
 */
export { BarMeter, type BarMeterProps } from './BarMeter';
export {
  ChunkyButton,
  IconButton,
  type ChunkyButtonProps,
  type ChunkyVariant,
  type IconButtonProps,
} from './Buttons';
export { ChoiceCards, type Choice, type ChoiceCardsProps } from './ChoiceCards';
export { Confetti, type ConfettiProps } from './Confetti';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Heatmap, heatLevel, type HeatmapProps } from './Heatmap';
export { IconTabBar, type IconTab, type IconTabBarProps } from './IconTabBar';
export { InfoTip, type InfoTipProps } from './InfoTip';
export { focusables, trapTab, useModalDialog } from './modal';
export { MoreGrid, type MoreItem } from './MoreGrid';
export { prefersReducedMotion, useReducedMotion, type Tone } from './motion';
export { ProgressRing, type ProgressRingProps } from './ProgressRing';
export { StatChip, type StatChipProps } from './StatChip';
export { Stepper, type StepperProps } from './Stepper';
export { VaultBuddy, type BuddyPose, type VaultBuddyProps } from './VaultBuddy';
export { Wizard, type WizardProps, type WizardStep, type WizardStepContext } from './Wizard';
export { useXpFloat } from './XpFloat';
