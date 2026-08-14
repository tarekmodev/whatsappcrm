'use client';

import { useState } from 'react';
import type { AssignmentRuleResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { SectionCard } from '@/components/ui/SectionCard';
import { useContent } from '@/lib/content';
import type { RoutingRuleVocabulary } from '../presentation';
import { RoutingRulesList, RoutingRulesListSkeleton } from './RoutingRulesList';
import { LazyRuleFormDialog } from './rule-dialogs.lazy';

/**
 * The routing-rule section: the card, the add trigger and the list. Usage:
 * `<RoutingRulesSection rules={rules} vocabulary={vocabulary} canWrite />`.
 *
 * `canWrite` comes from the server's permission check, so a principal holding
 * only `assignment_rule:read` is never rendered a control that leads to a refusal.
 */
export function RoutingRulesSection({
  rules,
  vocabulary,
  canWrite,
}: {
  rules: readonly AssignmentRuleResponse[];
  vocabulary: RoutingRuleVocabulary;
  canWrite: boolean;
}) {
  const content = useContent();
  const copy = content.routingRules;
  const [isAdding, setIsAdding] = useState(false);

  return (
    <SectionCard
      id="routing-rules"
      title={copy.heading}
      description={copy.sectionDescription}
      action={
        canWrite ? (
          <Button
            variant="primary"
            onClick={() => {
              setIsAdding(true);
            }}
          >
            {copy.addRule}
          </Button>
        ) : undefined
      }
    >
      <RoutingRulesList rules={rules} vocabulary={vocabulary} canWrite={canWrite} />

      {isAdding ? (
        <LazyRuleFormDialog
          vocabulary={vocabulary}
          onClose={() => {
            setIsAdding(false);
          }}
        />
      ) : null}
    </SectionCard>
  );
}

/** Mirrors the section's frame, with the list's own skeleton inside it. */
export function RoutingRulesSectionSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <SectionCard
      id="routing-rules"
      title={content.routingRules.heading}
      description={content.routingRules.sectionDescription}
    >
      <RoutingRulesListSkeleton hasActions={hasActions} />
    </SectionCard>
  );
}
