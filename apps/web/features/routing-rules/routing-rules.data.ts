import 'server-only';

import type { AssignmentRuleResponse } from '@whatsappcrm/contracts';
import { listAssignmentRules } from '@/lib/api/assignment-rules';
import { listCustomFieldDefinitions, listTags } from '@/lib/api/contact-schema';
import { listTeams } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { AGENTS_PAGE_SIZE } from '@/features/people/constants';
import type { RoutingRuleVocabulary } from './presentation';

/**
 * Everything the rule surface renders: the rules themselves, plus the teams,
 * agents, tags and contact fields their conditions and targets point at.
 *
 * The four vocabulary reads are what turn a stored UUID back into "the Billing
 * team" — a rule list that showed ids would be unreadable, and a condition form
 * that asked a supervisor to type one would be unusable.
 *
 * All five run in parallel and all five are tenant-scoped by the API from the
 * session cookie. There is no tenant parameter here to get wrong, and no read
 * that could be widened by a query string.
 */

export interface RoutingRulesData {
  readonly rules: readonly AssignmentRuleResponse[];
  readonly vocabulary: RoutingRuleVocabulary;
}

export async function loadRoutingRules(): Promise<RoutingRulesData> {
  const [rules, teams, users, tags, customFields] = await Promise.all([
    listAssignmentRules(),
    listTeams(),
    listUsers({ limit: AGENTS_PAGE_SIZE }),
    listTags(),
    listCustomFieldDefinitions(),
  ]);

  return {
    rules,
    vocabulary: { teams: teams.items, users: users.items, tags, customFields },
  };
}
