'use client';

import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { Field } from '@/components/ui/Field';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonBlock, SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { StaticFieldValue } from '@/components/ui/StaticFieldValue';
import { useContent } from '@/lib/content';
import styles from './WorkspaceProfileForm.module.css';

/**
 * Mirrors `WorkspaceProfileForm` — the same wrapper and measure cap, the same
 * three `Field`s with the same labels and hints, the same right-aligned action
 * row — so the lazy boundary hands over without the card changing height.
 *
 * The labels and the hints are real strings, because they are copy the skeleton
 * already knows; only the values and the button are placeholders. The two
 * editable controls are `SkeletonBlock`s at the control height token, which is
 * the exact height a `TextInput` occupies, and the read-only address is a text
 * line because that is what it is in the form too.
 *
 * `'use client'`, and it has to be: it renders through the real `Field`, whose
 * render-prop children are a function, and a function cannot cross the
 * server-to-client boundary — `loading.tsx` renders this from a server component
 * and React refuses. The alternative is what the auth skeletons do, hand-drawing
 * a label line and a control block with `Skeleton` primitives; that stays a
 * server component and drifts the moment `Field`'s spacing changes. Rendering the
 * real thing is worth the client boundary, and this is a `next/dynamic` fallback
 * anyway, so it was going to the client regardless.
 *
 * Changed in the same commit as the form it stands in for.
 */
export function WorkspaceProfileFormSkeleton() {
  const content = useContent();

  return (
    <div className={styles.form}>
      <Stack gap="4">
        <LoadingAnnouncement label={content.workspace.loading} />
        <Field label={content.workspace.nameLabel} isRequired>
          {() => <SkeletonBlock height="var(--size-control-md)" />}
        </Field>
        <Field
          label={content.workspace.supportEmailLabel}
          hint={content.workspace.supportEmailHint}
        >
          {() => <SkeletonBlock height="var(--size-control-md)" />}
        </Field>
        <Field label={content.workspace.addressLabel} hint={content.workspace.addressHint}>
          {() => (
            <StaticFieldValue>
              <SkeletonLine width="14rem" />
            </StaticFieldValue>
          )}
        </Field>
        <Cluster justify="end">
          <span aria-hidden="true" className={styles.actionPlaceholder}>
            <SkeletonForText>{content.workspace.saveProfile}</SkeletonForText>
          </span>
        </Cluster>
      </Stack>
    </div>
  );
}
