import type { HealthStatus } from '@whatsappcrm/contracts';

const LABELS: Record<HealthStatus, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
};

const COLORS: Record<HealthStatus, string> = {
  ok: '#15803d',
  degraded: '#b45309',
  down: '#b91c1c',
};

export function StatusBadge({ status }: { status: HealthStatus }) {
  return (
    <span role="status" data-status={status} style={{ color: COLORS[status], fontWeight: 600 }}>
      {LABELS[status]}
    </span>
  );
}
