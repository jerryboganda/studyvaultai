import {
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStep,
} from '@ui/shell/onboardingState';

/** Pure helpers of the welcome tour: step order, titles and where to start. */

export const STEP_TITLES: Record<OnboardingStep, string> = {
  welcome: 'What StudyVault does',
  privacy: 'Your privacy choices',
  access: 'How site access works',
  banks: 'Start with a bank',
  look: 'Theme and density',
  keys: 'Keyboard shortcuts',
  done: 'You are ready',
};

export const STEP_COUNT = ONBOARDING_STEPS.length;

export const stepIndex = (step: OnboardingStep): number => ONBOARDING_STEPS.indexOf(step);

export function nextStep(step: OnboardingStep): OnboardingStep {
  return ONBOARDING_STEPS[Math.min(stepIndex(step) + 1, STEP_COUNT - 1)] ?? 'done';
}

export function prevStep(step: OnboardingStep): OnboardingStep {
  return ONBOARDING_STEPS[Math.max(stepIndex(step) - 1, 0)] ?? 'welcome';
}

/**
 * Where the tour opens: a tour in progress resumes at its step; a finished or skipped one (opened
 * again from Settings) starts from the beginning.
 */
export function startStep(state: OnboardingState): OnboardingStep {
  return state.status === 'pending' ? state.step : 'welcome';
}
