'use server';

import {
  CreateKnowledgeDocumentInputSchema,
  UpdateAiConfigInputSchema,
  UpdateKnowledgeDocumentInputSchema,
} from '@whatsappcrm/contracts';
import type { KnowledgeDocumentResponse } from '@whatsappcrm/contracts';
import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  reindexKnowledgeDocument,
  updateAiConfig,
  updateKnowledgeDocument,
} from '@/lib/api/ai';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * Mutations for the chatbot surface. Each asserts `ai:write` — the permission
 * ADR 0010 assigns every write here — validates against the contract's own
 * schema, and comes back as a value rather than a throw; `runAction` owns that
 * sequence.
 *
 * Nothing here restates a rule the contract or the API already holds: the
 * confidence bounds, the model allowlist, the 256 KiB content cap and the
 * per-tenant document cap are all enforced where they are declared. A second
 * copy in this module would be a second copy to get subtly wrong.
 */

/** The surface these mutations re-render. `settingsChatbot()` takes no query. */
const CHATBOT_PATH = routes.settingsChatbot();

const ACTION_LABEL = 'Chatbot settings';

export async function updateChatbotSettingsAction(
  input: unknown,
): Promise<ActionResult<{ isEnabled: boolean }>> {
  return runAction({
    permission: 'ai:write',
    parser: UpdateAiConfigInputSchema,
    input,
    revalidate: CHATBOT_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const config = await updateAiConfig(parsed);

      return { isEnabled: config.isEnabled };
    },
  });
}

/**
 * One entry with its text, for the editor about to open on it.
 *
 * A read, so it revalidates nothing: the list it was opened from is already
 * rendered and re-rendering the route behind a dialog would be work nobody asked
 * for. It exists at all because the list endpoint omits `content` — a page of
 * entries each holding up to 256 KiB is a response nobody wants — and an editor
 * prefilled from a list row would save that absence back over the entry.
 *
 * `ai:read`, not `ai:write`: opening the editor is a read, and the write it may
 * lead to asserts its own permission.
 */
export async function loadKnowledgeEntryAction(
  documentId: string,
): Promise<ActionResult<KnowledgeDocumentResponse>> {
  return runAction({
    permission: 'ai:read',
    parser: null,
    input: undefined,
    revalidate: null,
    label: ACTION_LABEL,
    perform: async () => getKnowledgeDocument(documentId),
  });
}

export async function createKnowledgeEntryAction(
  input: unknown,
): Promise<ActionResult<{ title: string }>> {
  return runAction({
    permission: 'ai:write',
    parser: CreateKnowledgeDocumentInputSchema,
    input,
    revalidate: CHATBOT_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const document = await createKnowledgeDocument(parsed);

      return { title: document.title };
    },
  });
}

export async function updateKnowledgeEntryAction(
  documentId: string,
  input: unknown,
): Promise<ActionResult<{ title: string }>> {
  return runAction({
    permission: 'ai:write',
    parser: UpdateKnowledgeDocumentInputSchema,
    input,
    revalidate: CHATBOT_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const document = await updateKnowledgeDocument(documentId, parsed);

      return { title: document.title };
    },
  });
}

/**
 * The recovery path for an entry whose indexing failed, and the only way a
 * pending entry moves forward on demand.
 *
 * The title is passed in rather than read back from the response so the toast
 * can name the entry even though the endpoint answers `202` — the work has been
 * accepted, not finished, and the response says nothing new.
 */
export async function reindexKnowledgeEntryAction(
  documentId: string,
  title: string,
): Promise<ActionResult<{ title: string }>> {
  return runAction({
    permission: 'ai:write',
    parser: null,
    input: undefined,
    revalidate: CHATBOT_PATH,
    label: ACTION_LABEL,
    perform: async () => {
      await reindexKnowledgeDocument(documentId);

      return { title };
    },
  });
}

export async function deleteKnowledgeEntryAction(
  documentId: string,
  title: string,
): Promise<ActionResult<{ title: string }>> {
  return runAction({
    permission: 'ai:write',
    parser: null,
    input: undefined,
    revalidate: CHATBOT_PATH,
    label: ACTION_LABEL,
    perform: async () => {
      await deleteKnowledgeDocument(documentId);

      return { title };
    },
  });
}
