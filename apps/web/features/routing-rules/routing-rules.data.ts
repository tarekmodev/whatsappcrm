import 'server-only';

import type { AssignmentRuleResponse } from '@whatsappcrm/contracts';
import { listAssignmentRules } from '@/lib/api/assignment-rules';
import { listCustomFieldDefinitions, listTags } from '@/lib/api/contact-schema';
import { listTeams } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { VOCABULARY_LIMIT } from './constants';
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
 *
 * **Every vocabulary read asks for the same `VOCABULARY_LIMIT`.** A short read
 * here does not truncate a list — nothing on this surface paginates — it makes a
 * card claim an agent was removed when they are active and taking work, and hides
 * them from the target picker. So the cap is a correctness bound, not a page size.
 *
 * ⚠️ **Above `VOCABULARY_LIMIT` agents, that mislabelling returns**, because 100
 * is the contract's per-read ceiling (`CursorPageQuerySchema`). Fixing it properly
 * needs either a name-resolution endpoint that takes the ids a rule actually
 * references, or paging until the referenced ids are all resolved — both of which
 * want the real endpoints TAR-288 lands, not the mock. Raised on TAR-289.
 */

export interface RoutingRulesData {
  readonly rules: readonly AssignmentRuleResponse[];
  readonly vocabulary: RoutingRuleVocabulary;
}

export async function loadRoutingRules(): Promise<RoutingRulesData> {
  const [rules, teams, users, tags, customFields] = await Promise.all([
    listAssignmentRules(),
    listTeams(),
    listUsers({ limit: VOCABULARY_LIMIT }),
    listTags(),
    listCustomFieldDefinitions(),
  ]);

  return {
    rules,
    vocabulary: { teams: teams.items, users: users.items, tags, customFields },
  };
}
