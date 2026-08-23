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
  REGISTRATION_STATUS_TONES,
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

      {account.accounts.some((number) => number.registrationStatus !== 'registered') ? (
        <Notice tone="warning">{content.whatsapp.registrationNotice}</Notice>
      ) : null}
    </Stack>
  );
}

/**
 * Built from `content` rather than declared at module scope so a locale added
 * later changes the headers without touching this component.
 *
 * ## Three marks, two chips (0001, "A table row is the one place the budget is two")
 *
 * The row now answers three questions, and the budget is two — so they are ranked
 * most-actionable first and the loser goes quiet rather than away.
 *
 *   1. **Can it send** (`registrationStatus`). The one a workspace acts on: a
 *      number that Meta never registered receives normally and refuses every
 *      send, which is invisible from anywhere else in the console.
 *   2. **Is it attached** (`status`). Meta reporting the number as unreachable is
 *      the next thing worth a glance.
 *   3. **What Meta thinks of it** (`qualityRating`). Real, and nothing to do
 *      about today — so it keeps its word and gives up its pill.
 *
 * A column header stays whether or not its cell has a chip in it, and below 40rem
 * `DataTable` repeats that header beside the value, so dropping the third mark
 * would leave a labelled blank that reads as missing data.
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
          // Third by rank, so `quiet`: the word stays, the pill goes. `tone` is
          // ignored by the variant, which is why the table above it is not there.
          <Badge variant="quiet">{content.whatsapp.qualityRatings[row.qualityRating]}</Badge>
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
    {
      key: 'registration',
      header: content.whatsapp.columnRegistration,
      isNarrow: true,
      render: (row) => (
        <Badge tone={REGISTRATION_STATUS_TONES[row.registrationStatus]}>
          {content.whatsapp.wizard.registrationStatuses[row.registrationStatus]}
        </Badge>
      ),
    },
  ];
}
