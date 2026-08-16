'use client';

import dynamic from 'next/dynamic';
import { BrandingPreviewSkeleton } from './BrandingPreview.Skeleton';

/**
 * The live colour preview, in its own chunk.
 *
 * What actually splits out, stated precisely rather than optimistically: the
 * preview component, its module CSS, and `brandCssVariables` — the ramps, the
 * mixing and the seven-token assembly. What does **not** split is
 * `contrastRatio` and `onAccentFor`, because the contrast readout beside each
 * colour field needs them, so they are in the form's own chunk either way.
 *
 * That is still worth a boundary: the preview is below the fields, is not needed
 * to type into one, and is the only place in the console that assembles a whole
 * token set on the client.
 *
 * `ssr: false` because there is nothing to server-render: it shows the *draft* a
 * client component is holding, so a server pass could only ever paint the saved
 * values and then replace them on hydration. Its skeleton is the better thing to
 * send, and it occupies the same box.
 */
export const LazyBrandingPreview = dynamic(
  async () => (await import('./BrandingPreview')).BrandingPreview,
  { ssr: false, loading: () => <BrandingPreviewSkeleton /> },
);
