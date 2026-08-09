import { API_BASE_URL } from '@/lib/api';
import { StatusBadge } from '@/components/status-badge';

export default function HomePage() {
  return (
    <main>
      <h1>WhatsApp CRM</h1>
      <p style={{ color: 'var(--muted)' }}>
        Scaffold only. The agent console is built by the TAR-18 stories.
      </p>
      <dl>
        <dt>Frontend</dt>
        <dd>
          <StatusBadge status="ok" />
        </dd>
        <dt>API base URL</dt>
        <dd>
          <code>{API_BASE_URL}</code>
        </dd>
      </dl>
    </main>
  );
}
