import { createContext, useContext } from 'react';
import {
  checkFilingRules,
  createFilingRule,
  deleteFilingRule,
  listFilingRules,
  reorderFilingRules,
  restoreFilingRule,
  updateFilingRule,
  type FilingRuleInput,
  type FilingRuleProblem,
  type SaveOutcome,
} from '@storage';
import type { FilingRule } from '@shared';

/**
 * What the filing-rules manager asks of storage (docs/adr/017-filing-rules.md), as one injectable
 * object: the real repositories in the extension, a fake in tests. Kept apart from `DashboardApi`
 * (the vault) so the rules manager can be tested without the whole vault double.
 */
export interface RulesApi {
  listFilingRules(): Promise<FilingRule[]>;
  checkFilingRules(): Promise<FilingRuleProblem[]>;
  createFilingRule(input: FilingRuleInput): Promise<FilingRule>;
  updateFilingRule(
    id: string,
    patch: Partial<FilingRuleInput>,
    options?: { expectedVersion?: string },
  ): Promise<SaveOutcome<FilingRule>>;
  reorderFilingRules(orderedIds: readonly string[]): Promise<FilingRule[]>;
  deleteFilingRule(id: string): Promise<void>;
  restoreFilingRule(id: string): Promise<FilingRule>;
}

export const realRulesApi: RulesApi = {
  listFilingRules: () => listFilingRules(),
  checkFilingRules,
  createFilingRule,
  updateFilingRule,
  reorderFilingRules,
  deleteFilingRule,
  restoreFilingRule,
};

const RulesApiContext = createContext<RulesApi>(realRulesApi);
export const RulesApiProvider = RulesApiContext.Provider;
export const useRulesApi = (): RulesApi => useContext(RulesApiContext);
