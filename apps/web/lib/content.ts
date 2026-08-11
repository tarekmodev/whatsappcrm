import { content, type Content } from '@/content/en';

/**
 * The accessor every component uses to reach copy. It is deliberately a plain
 * function rather than a hook so server and client components share one call
 * shape, and so a future locale lookup (TAR-29 white-labelling adds one) can be
 * introduced here without touching a single component.
 */
export function useContent(): Content {
  return content;
}

export type { Content };
