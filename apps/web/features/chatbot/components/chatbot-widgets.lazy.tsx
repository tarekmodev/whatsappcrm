'use client';

import dynamic from 'next/dynamic';
import { ChatbotSettingsFormSkeleton } from './ChatbotSettingsForm.Skeleton';

export const LazyChatbotSettingsForm = dynamic(
  async () => (await import('./ChatbotSettingsForm')).ChatbotSettingsForm,
  { loading: () => <ChatbotSettingsFormSkeleton /> },
);
