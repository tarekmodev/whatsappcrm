'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/ToastProvider';
import { useContent } from '@/lib/content';
import styles from './DnsRecord.module.css';

/**
 * One DNS record, spelled exactly and copyable field by field. Usage:
 * `<DnsRecord type="TXT" name={…} value={…} />`.
 *
 * Every value is rendered in a monospace `<dd>` with `user-select: all` and a
 * copy button beside it, because the audience for this component is somebody
 * alt-tabbing between here and a registrar's control panel. A mistyped
 * verification token is the single most common reason a domain never verifies,
 * and it is indistinguishable from "DNS has not propagated yet" for an hour.
 *
 * A `<dl>` rather than a table: three name/value pairs are a description list,
 * and a table would announce a column structure that is not there.
 *
 * Copy is best-effort. `navigator.clipboard` is unavailable over plain HTTP and
 * can be refused by permissions policy, so a failure leaves the value on screen —
 * still selectable, still readable — rather than claiming a copy that did not
 * happen.
 */

export interface DnsRecordProps {
  type: string;
  name: string;
  value: string;
}

export function DnsRecord({ type, name, value }: DnsRecordProps) {
  const content = useContent();

  return (
    <dl className={styles.record}>
      <div className={styles.row}>
        <dt className={styles.term}>{content.domains.recordType}</dt>
        <dd className={styles.value}>{type}</dd>
      </div>
      <CopyableRow term={content.domains.recordName} value={name} />
      <CopyableRow term={content.domains.recordValue} value={value} />
    </dl>
  );
}

function CopyableRow({ term, value }: { term: string; value: string }) {
  const content = useContent();
  const { showToast } = useToast();

  const copy = useCallback(() => {
    // Optional chaining rather than a feature check plus a call: `clipboard` is
    // undefined on an insecure origin, which is exactly where a self-hosted
    // deployment tends to be tested.
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        showToast({ tone: 'success', message: content.domains.copiedToast });
      })
      .catch((error: unknown) => {
        // Not swallowed, and not surfaced as a failure the user must act on —
        // the value is on screen and selectable either way.
        console.error('Copying a DNS record to the clipboard failed', error);
      });
  }, [content, showToast, value]);

  return (
    <div className={styles.row}>
      <dt className={styles.term}>{term}</dt>
      <dd className={styles.value}>
        <code className={styles.code}>{value}</code>
        <Button size="sm" variant="ghost" onClick={copy}>
          {content.domains.copyRecord(term)}
        </Button>
      </dd>
    </div>
  );
}
