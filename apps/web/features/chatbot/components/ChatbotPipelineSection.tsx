import { Badge } from '@/components/ui/Badge';
import { Cluster } from '@/components/layout/Cluster';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { loadChatbotConfig, loadSourceHealth } from '../chatbot.data';
import { CHATBOT_SECTION_IDS } from '../constants';
import { chatbotPipeline } from '../pipeline';
import { PipelineRail } from './PipelineRail';
import styles from './ChatbotPipelineSection.module.css';

/**
 * The top of the chatbot surface: whether it is answering, and the path it takes
 * to decide. Usage: inside an unkeyed Suspense boundary, with
 * `ChatbotPipelineSectionSkeleton` as the fallback.
 *
 * Replaces the readiness card's bullet list of blockers (TAR-813). Every blocker
 * that is a *stage* now shows up as that stage's own value line and dot, so
 * listing them underneath would be the same four facts told twice. The two that
 * are not stages stay as notices, because they are conditions on the deployment
 * and on the plan rather than steps in the bot's path — marking a stage for
 * either would send an admin to fix the wrong thing.
 *
 * A server component: the reads and the derivation happen on the server, and the
 * client bundle carries only the rail's focus handler.
 *
 * **Readiness still comes first, and it still sets nothing.** The single most
 * important fact on this page is whether customers are getting automated replies
 * right now; the switch that changes it lives in stage B, and this card only
 * ever reports.
 */
export async function ChatbotPipelineSection() {
  const [config, health] = await Promise.all([loadChatbotConfig(), loadSourceHealth()]);
  const pipeline = chatbotPipeline(content, config, health);

  return (
    <SectionCard
      id={CHATBOT_SECTION_IDS.pipeline}
      title={content.chatbot.pipelineHeading}
      description={content.chatbot.pipelineDescription}
    >
      <Stack gap="4">
        <Stack gap="2">
          <Cluster gap="3" align="center">
            {/* `warning`, not `danger`: a chatbot that is not answering is the
                product's normal state and its safe one — a person answers,
                exactly as they did before the feature existed. */}
            <Badge tone={pipeline.isReady ? 'success' : 'warning'}>
              {pipeline.isReady ? content.chatbot.readinessOn : content.chatbot.readinessOff}
            </Badge>
            <p className={styles.heading}>
              {pipeline.isReady ? content.chatbot.readyHeading : content.chatbot.notReadyHeading}
            </p>
          </Cluster>
          <p className={styles.body}>
            {pipeline.isReady
              ? content.chatbot.readyBody(config.readiness.indexedDocumentCount)
              : content.chatbot.notReadyBody}
          </p>
        </Stack>

        {/* Above the rail, in the order the API declares them — cheapest to
            check first, which is also least in the tenant's control first. */}
        {pipeline.conditions.map((blocker) => (
          <Notice key={blocker} tone="warning">
            {content.chatbot.blockers[blocker]}
          </Notice>
        ))}

        <PipelineRail stages={pipeline.stages} />
      </Stack>
    </SectionCard>
  );
}

/**
 * The fallback: the same card, the same verdict row, and four tiles' worth of
 * height, so the swap to a real answer moves nothing below it.
 *
 * No notice is drawn. Whether one appears depends on the plan, which has not
 * arrived, and reserving space for it would leave a gap on the common path where
 * there is nothing to say.
 *
 * Changed in the same commit as the section it stands in for.
 */
export function ChatbotPipelineSectionSkeleton() {
  return (
    <SectionCard
      id={CHATBOT_SECTION_IDS.pipeline}
      title={content.chatbot.pipelineHeading}
      description={content.chatbot.pipelineDescription}
    >
      <Stack gap="4" aria-hidden="true">
        <Stack gap="2">
          <Cluster gap="3" align="center">
            <SkeletonLine width="6rem" height="1.25rem" />
            <SkeletonLine width="14rem" height="var(--font-size-body-lg)" />
          </Cluster>
          <SkeletonText lines={2} />
        </Stack>
        <ol className={styles.railPlaceholder}>
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className={styles.tilePlaceholder}>
              <SkeletonLine width="var(--size-stage-marker)" height="var(--size-stage-marker)" />
              <SkeletonLine width="70%" height="var(--font-size-body-sm)" />
              <SkeletonLine width="90%" height="var(--font-size-caption)" />
            </li>
          ))}
        </ol>
      </Stack>
    </SectionCard>
  );
}
