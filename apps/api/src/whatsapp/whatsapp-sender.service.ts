import { Injectable } from '@nestjs/common';
import { MetaCloudApiClient, type MediaReference, type SentMessage } from './meta-cloud-api.client';
import { WhatsAppCredentialResolver } from './whatsapp-credential.resolver';

/**
 * A send, addressed the way the rest of the platform has it: by our id for the
 * connected number, never by Meta's. A caller that had to supply
 * `phoneNumberId` and an access token would be a caller that had to resolve
 * credentials, which is the thing this module exists to keep in one place.
 */
interface SendCommandBase {
  /** `whatsapp_accounts.id` — the number the conversation belongs to. */
  whatsappAccountId: string;
  /** The recipient in E.164. */
  to: string;
}

export interface SendTextMessageCommand extends SendCommandBase {
  body: string;
  previewUrl?: boolean;
}

export interface SendMediaMessageCommand extends SendCommandBase {
  kind: 'image' | 'video' | 'audio' | 'document';
  media: MediaReference;
  caption?: string;
  filename?: string;
}

export interface SendTemplateMessageCommand extends SendCommandBase {
  templateName: string;
  languageCode: string;
  variables?: readonly string[];
}

/**
 * The send path (TAR-39, security: WhatsApp access tokens are "decrypted only in
 * the send path"). This is that path, and the only caller of the Cloud API
 * client that also touches the database.
 *
 * ## Why this sits between the client and its callers
 *
 * The client is a transport that takes a token; the resolver is the one place a
 * token is decrypted. Something has to join the two, and doing it here rather
 * than in each caller means the ordering — resolve, use once, discard — is
 * written once. TAR-20c's inbox send path and TAR-27's workflow actions both
 * call these three methods and never see a credential.
 *
 * ## What it deliberately does not do
 *
 *   * **No service-window check.** Whether an outbound message is allowed
 *     without a template is a conversation-level rule, and `conversations` is
 *     TAR-20c's. Putting it here would mean this module reading a table it does
 *     not own, to enforce a rule its own callers would still have to know about.
 *   * **No message row.** Nothing here writes to `messages`. The caller creates
 *     the row, calls this, and records the id it gets back — which is what lets
 *     that whole sequence be one transaction plus one external call, in the
 *     order the caller needs.
 *   * **No idempotency, and no retry.** Two identical calls are two messages to
 *     the customer. `Idempotency-Key` is TAR-20c's, retry and backoff belong to
 *     the queue that owns the attempt count.
 */
@Injectable()
export class WhatsAppSenderService {
  constructor(
    private readonly credentials: WhatsAppCredentialResolver,
    private readonly cloudApi: MetaCloudApiClient,
  ) {}

  async sendText(command: SendTextMessageCommand): Promise<SentMessage> {
    const { phoneNumberId, accessToken } = await this.credentials.forPhoneNumber(
      command.whatsappAccountId,
    );

    return this.cloudApi.sendText({
      phoneNumberId,
      accessToken,
      to: command.to,
      body: command.body,
      previewUrl: command.previewUrl,
    });
  }

  async sendMedia(command: SendMediaMessageCommand): Promise<SentMessage> {
    const { phoneNumberId, accessToken } = await this.credentials.forPhoneNumber(
      command.whatsappAccountId,
    );

    return this.cloudApi.sendMedia({
      phoneNumberId,
      accessToken,
      to: command.to,
      kind: command.kind,
      media: command.media,
      caption: command.caption,
      filename: command.filename,
    });
  }

  /**
   * The template is named, not looked up. Meta validates the name, language and
   * placeholder count on its side and rejects a mismatch, so a local pre-check
   * would duplicate a rule that would still have to be handled when Meta
   * disagreed with it — and would go stale the moment Meta paused a template
   * between our read and the send.
   */
  async sendTemplate(command: SendTemplateMessageCommand): Promise<SentMessage> {
    const { phoneNumberId, accessToken } = await this.credentials.forPhoneNumber(
      command.whatsappAccountId,
    );

    return this.cloudApi.sendTemplate({
      phoneNumberId,
      accessToken,
      to: command.to,
      templateName: command.templateName,
      languageCode: command.languageCode,
      variables: command.variables,
    });
  }
}
