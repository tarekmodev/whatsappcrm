'use client';

import { Field } from '@/components/ui/Field';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { ENTRY_CONTENT_ROWS } from '../constants';

/**
 * Mirrors `KnowledgeEntryForm`'s fields while the entry it will edit is being
 * read. Usage: as the body of `KnowledgeEntryDialog` before the entry arrives.
 *
 * The frame around it — panel, header, footer row — is `FormDialog`'s and is
 * already on screen, so only the three fields are placeholders. Labels and hints
 * are the real copy, because the skeleton already knows them; a dialog that
 * showed grey bars where its labels will be would be hiding something it has.
 *
 * `'use client'`, and it has to be: it renders the real `Field`, whose children
 * are a render prop, and a function cannot cross the server-to-client boundary.
 * Rendering the real `Field` is what stops this drifting when its spacing
 * changes.
 *
 * Changed in the same commit as the form it stands in for.
 */
export function KnowledgeEntryFormSkeleton() {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.chatbot.editLoading} />

      <Field label={content.chatbot.entryTitleLabel} isRequired>
        {() => <SkeletonBlock height="var(--size-touch-target)" />}
      </Field>
      <Field label={content.chatbot.entryContentLabel} isRequired>
        {() => <SkeletonBlock height={TEXTAREA_HEIGHT} />}
      </Field>
      <Field label={content.chatbot.entrySourceUrlLabel} hint={content.chatbot.entrySourceUrlHint}>
        {() => <SkeletonBlock height="var(--size-touch-target)" />}
      </Field>
    </>
  );
}

/**
 * The box a `rows={ENTRY_CONTENT_ROWS}` textarea occupies, computed from the
 * same tokens `Control.module.css` styles it with rather than guessed at: the
 * text itself, the control's vertical padding and its two borders. A fixed
 * height here would be right at one type scale and wrong at every other.
 */
const TEXTAREA_HEIGHT = `calc(
  ${String(ENTRY_CONTENT_ROWS)} * var(--font-size-body) * var(--line-height-body) +
  2 * var(--space-2) + 2 * var(--border-hairline)
)`;
