import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaCloudApiClient, type MetaMediaDescriptor } from './meta-cloud-api.client';
import { WhatsAppCredentialResolver } from './whatsapp-credential.resolver';

/** One inbound media object: what Meta says it is, and the bytes themselves. */
export interface InboundMediaDownload {
  readonly descriptor: MetaMediaDescriptor;
  readonly body: Readable;
}

export interface DownloadInboundMediaCommand {
  /** `whatsapp_accounts.id` — the number the message arrived on. */
  whatsappAccountId: string;
  /** Meta's handle, from the inbound message payload. */
  providerMediaId: string;
}

export interface UploadOutboundMediaCommand {
  /** `whatsapp_accounts.id` — the number the media will be sent from. */
  whatsappAccountId: string;
  file: Blob;
  mimeType: string;
  fileName: string;
}

/**
 * Media against the Cloud API, with the credential resolution the media
 * pipeline must not do for itself.
 *
 * ## Why this lives in `WhatsAppModule` and not in `MediaModule`
 *
 * Because of one property worth protecting: `WhatsAppCredentialResolver` is the
 * only place a stored access token is decrypted, and it is deliberately not
 * exported (TAR-39, security). A media pipeline that resolved its own
 * credentials would be the second place, and the value of "one place" is
 * entirely in there being one.
 *
 * So the split is: this module knows how to talk to Meta as a tenant, and
 * `MediaModule` knows what a stored binary is and where it goes. Neither knows
 * the other's half. It is the same shape as `WhatsAppSenderService`, which is
 * why the two sit side by side rather than one growing into the other — a
 * download is not a send, and folding it into the send path would put "fetch
 * something from Meta" behind a class whose whole documented contract is
 * "deliver a message to a customer".
 *
 * ## Timeouts
 *
 * Both directions are transfers rather than JSON round trips, so both take
 * `MEDIA_DOWNLOAD_TIMEOUT_MS` rather than the Graph API's much tighter one. The
 * `describeMedia` call in between keeps the tight bound: it is a small JSON
 * exchange, and a slow one is a sign to give up early — the URL it returns is
 * only valid for five minutes anyway.
 */
@Injectable()
export class WhatsAppMediaService {
  private readonly transferTimeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly credentials: WhatsAppCredentialResolver,
    private readonly cloudApi: MetaCloudApiClient,
  ) {
    this.transferTimeoutMs = config.getOrThrow<number>('MEDIA_DOWNLOAD_TIMEOUT_MS');
  }

  /**
   * Resolves Meta's handle to a URL and opens the transfer.
   *
   * Returns the stream rather than the bytes: the caller pipes it into storage,
   * counting and hashing on the way, and a 100 MB document therefore never
   * exists in this process's heap. The descriptor comes back alongside it so
   * the caller can compare what it received against what Meta claimed.
   *
   * The two calls are made back to back on purpose. Meta's URL expires five
   * minutes after `describeMedia` issues it, so anything between the two — a
   * database write, a queue hop — is time spent against that window.
   */
  async downloadInbound(command: DownloadInboundMediaCommand): Promise<InboundMediaDownload> {
    const { accessToken } = await this.credentials.forPhoneNumber(command.whatsappAccountId);

    const descriptor = await this.cloudApi.describeMedia({
      providerMediaId: command.providerMediaId,
      accessToken,
    });

    const body = await this.cloudApi.downloadMedia({
      url: descriptor.url,
      accessToken,
      timeoutMs: this.transferTimeoutMs,
    });

    return { descriptor, body: Readable.fromWeb(body) };
  }

  /**
   * Uploads bytes to the number they will be sent from, and returns Meta's
   * handle.
   *
   * The handle is the caller's to use once and discard. It is scoped to this
   * phone number and expires on Meta's schedule, so storing it would be a
   * cache whose staleness a customer discovers.
   */
  async uploadOutbound(command: UploadOutboundMediaCommand): Promise<string> {
    const { phoneNumberId, accessToken } = await this.credentials.forPhoneNumber(
      command.whatsappAccountId,
    );

    return await this.cloudApi.uploadMedia({
      phoneNumberId,
      accessToken,
      file: command.file,
      mimeType: command.mimeType,
      fileName: command.fileName,
      timeoutMs: this.transferTimeoutMs,
    });
  }
}
