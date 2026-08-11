import type {
  ConnectedWhatsAppBusinessAccountResponse,
  WhatsAppAccountResponse,
} from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Notice } from '@/components/ui/Notice';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useContent, type Content } from '@/lib/content';
import {
  ACCOUNT_STATUS_TONES,
  QUALITY_RATING_TONES,
  VERIFICATION_STATUS_TONES,
} from '../presentation';
import styles from './ConnectedBusinessAccount.module.css';

/**
 * What a connection produced, rendered from the response body. Usage:
 * `<ConnectedBusinessAccount account={account} />`.
 *
 * Everything here comes from Meta by way of the API — the business name, the
 * verification status, the numbers and their display forms — and none of it from
 * the browser, which is the rule the endpoint itself follows: the authority on
 * what was connected is the party that issued the token.
 *
 * Presentational and server-renderable on purpose. The panel that holds it is a
 * client component because it drives Meta's SDK; this is not, so it stays usable
 * by a page that reads a connection back from an endpoint rather than from a
 * click, once such an endpoint exists.
 */
export function ConnectedBusinessAccount({
  account,
}: {
  account: ConnectedWhatsAppBusinessAccountResponse;
}) {
  const content = useContent();

  return (
    <Stack gap="4">
      <Stack gap="3" className={styles.summary}>
        <Cluster justify="between" align="start" gap="3">
          <h3 className={styles.name}>{account.name ?? content.whatsapp.unnamedAccount}</h3>
          <Badge tone={VERIFICATION_STATUS_TONES[account.verificationStatus]}>
            {content.whatsapp.verificationStatuses[account.verificationStatus]}
          </Badge>
        </Cluster>
        <div>
          <p className={styles.metaLabel}>{content.whatsapp.wabaIdLabel}</p>
          <p className={styles.metaValue}>{account.wabaId}</p>
        </div>
      </Stack>

      <p className={styles.numbersCount}>
        {content.whatsapp.connectedNumbersCount(account.accounts.length)}
      </p>
      <DataTable
        caption={content.whatsapp.connectedNumbersCaption}
        columns={numberColumns(content)}
        rows={account.accounts}
        getRowKey={(number) => number.id}
      />

      <Notice tone="info">{content.whatsapp.registrationNotice}</Notice>
    </Stack>
  );
}

/**
 * Built from `content` rather than declared at module scope so a locale added
 * later changes the headers without touching this component.
 */
function numberColumns(content: Content): DataTableColumn<WhatsAppAccountResponse>[] {
  return [
    {
      key: 'number',
      header: content.whatsapp.columnNumber,
      render: (row) => row.displayPhoneNumber,
    },
    {
      key: 'verifiedName',
      header: content.whatsapp.columnVerifiedName,
      render: (row) => row.verifiedName ?? content.whatsapp.noVerifiedName,
    },
    {
      key: 'quality',
      header: content.whatsapp.columnQuality,
      isNarrow: true,
      // `null` is "we have not asked Meta"; Meta's own `unknown` is "asked, and
      // Meta cannot rate it". Two different facts, so they read differently.
      render: (row) =>
        row.qualityRating === null ? (
          content.whatsapp.noQualityRating
        ) : (
          <Badge tone={QUALITY_RATING_TONES[row.qualityRating]}>
            {content.whatsapp.qualityRatings[row.qualityRating]}
          </Badge>
        ),
    },
    {
      key: 'status',
      header: content.whatsapp.columnNumberStatus,
      isNarrow: true,
      render: (row) => (
        <Badge tone={ACCOUNT_STATUS_TONES[row.status]}>
          {content.whatsapp.accountStatuses[row.status]}
        </Badge>
      ),
    },
  ];
}
