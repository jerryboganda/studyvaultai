import {
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStep,
} from '@ui/shell/onboardingState';

/**
 * Pure helpers of the welcome tour: step order, titles and where to start. The stored step ids
 * stay as they are (renaming one breaks resume); the welcome step also holds the daily goal and
 * the keys step is the "Try it" how-to with the shortcut list.
 */

export const STEP_TITLES: Record<OnboardingStep, string> = {
  welcome: 'Welcome to StudyVault',
  privacy: 'Your privacy',
  access: 'Turn on a site',
  banks: 'Starter bank',
  look: 'Pick a look',
  keys: 'Try it',
  done: 'You’re ready',
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
