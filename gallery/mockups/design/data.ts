// Sample choices shared by the preview's picture-card and wizard demos.
import { AppWindow, Coffee, Flame, Globe, MousePointerClick, Rocket, Sprout } from 'lucide-react';
import type { Choice } from '@ui/design';

export type Goal = '10' | '30' | '50' | '100';
export type Site = 'tab' | 'site' | 'all';

export const GOALS: Choice<Goal>[] = [
  { value: '10', label: 'Casual', hint: '10 XP a day', icon: Coffee, tone: 'success' },
  { value: '30', label: 'Regular', hint: '30 XP a day', icon: Sprout, tone: 'primary' },
  { value: '50', label: 'Serious', hint: '50 XP a day', icon: Flame, tone: 'warning' },
  { value: '100', label: 'Intense', hint: '100 XP a day', icon: Rocket, tone: 'violet' },
];
export const SITES: Choice<Site>[] = [
  { value: 'tab', label: 'This tab', hint: 'When you click', icon: MousePointerClick, tone: 'sun' },
  { value: 'site', label: 'One site', hint: 'Every visit', icon: AppWindow },
  { value: 'all', label: 'All sites', hint: 'Everywhere', icon: Globe, tone: 'warning' },
];
