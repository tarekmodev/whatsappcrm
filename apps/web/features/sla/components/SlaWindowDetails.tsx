import { SLA_DEFAULTS, type SlaPolicyResponse } from '@whatsappcrm/contracts';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { formatMinutes } from '@/lib/format/duration';
import { useContent, type Content } from '@/lib/content';
import { describeWindow } from '../window-form';

/**
 * The workspace's response window for a principal who may not change it. Usage:
 * `<SlaWindowDetails policy={defaultPolicy} />`.
 *
 * The same four facts `SlaWindowForm` holds, as text. A form of disabled inputs
 * was the alternative and is worse: `disabled` reads as "not right now" rather
 * than "never for you", and a disabled control is skipped by keyboard
 * navigation, so its value becomes unreadable to anyone tabbing through — the
 * rule `WorkspaceProfileDetails` and `StaticFieldValue` already document.
 *
 * The standard setting is a row of its own rather than a hint, because for this
 * reader it is the comparison that makes the workspace's own figure mean
 * anything: "45 minutes" says little until "the standard is 1 hour" is beside it.
 */
export function SlaWindowDetails({ policy }: { policy: SlaPolicyResponse }) {
  const content = useContent();

  return <DetailList items={details(policy, content)} />;
}

function details(policy: SlaPolicyResponse, content: Content): readonly DetailListItem[] {
  const copy = content.slaSettings;

  return [
    {
      id: 'active',
      term: copy.activeTerm,
      value: policy.isActive ? copy.activeYes : copy.activeNo,
    },
    {
      // `content.sla`, not a second copy: these are the same two targets the
      // ticket queue's badge names, and a workspace that calls one thing
      // "First response" on one screen and "First reply" on another has two
      // features as far as the reader is concerned.
      id: 'first-response',
      term: content.sla.firstResponse,
      value: describeWindow(policy.firstResponseMinutes),
    },
    {
      id: 'resolution',
      term: content.sla.resolution,
      value: describeWindow(policy.resolutionMinutes),
    },
    {
      id: 'standard',
      term: copy.standardLabel,
      value: formatMinutes(SLA_DEFAULTS.firstResponseMinutes, content),
      hint: copy.standardHint,
    },
  ];
}
