'use client';

import type { MessageTemplateResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { TEMPLATE_SKELETON_COUNT } from '@/features/inbox/constants';
import styles from './TemplatePicker.module.css';

/**
 * The approved templates this number may send, one row each. Usage:
 * `<TemplateList templates={…} onChoose={…} />`.
 *
 * Every row shows the body Meta approved, with its `{{1}}` placeholders left in.
 * That is the point of showing it: the agent is choosing which sentence to send,
 * and the gaps they will have to fill are part of the sentence.
 *
 * A name is unique only within a language, so both are on the row — a tenant
 * legitimately holds `order_update` in three of them.
 */

export interface TemplateListProps {
  templates: readonly MessageTemplateResponse[];
  onChoose: (template: MessageTemplateResponse) => void;
}

export function TemplateList({ templates, onChoose }: TemplateListProps) {
  const content = useContent();

  return (
    <ul className={styles.list}>
      {templates.map((template) => (
        <li key={template.id} className={styles.row}>
          <Stack gap="2">
            <Cluster justify="between" align="start" gap="3">
              <Stack gap="1">
                <span className={styles.name}>{template.name}</span>
                <span className={styles.language}>
                  {content.composer.templateLanguage(template.language)}
                </span>
              </Stack>
              <Button
                size="sm"
                onClick={() => {
                  onChoose(template);
                }}
                aria-label={content.composer.templateChooseAria(template.name)}
              >
                {content.composer.templateChoose}
              </Button>
            </Cluster>
            <p className={styles.body}>{template.bodyText ?? content.composer.templateNoPreview}</p>
          </Stack>
        </li>
      ))}
    </ul>
  );
}

/**
 * Mirrors `TemplateList`: the same rows at the same padding, each with a name
 * line, a language line and two body lines — so the swap to real templates does
 * not resize the dialog under the agent's cursor.
 */
export function TemplateListSkeleton() {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.composer.templateLoading} />
      <ul className={styles.list} aria-hidden="true">
        {Array.from({ length: TEMPLATE_SKELETON_COUNT }, (_unused, index) => (
          <li key={index} className={styles.row}>
            <Stack gap="2">
              <Cluster justify="between" align="start" gap="3">
                <Stack gap="1">
                  <SkeletonLine width="9rem" />
                  <SkeletonLine width="5rem" />
                </Stack>
                <SkeletonLine width="4.5rem" height="var(--size-control-sm)" />
              </Cluster>
              <SkeletonText lines={2} />
            </Stack>
          </li>
        ))}
      </ul>
    </>
  );
}
