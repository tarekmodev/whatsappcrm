import { z } from 'zod';

/**
 * Canonical error envelope. Every non-2xx API response has this shape, so the
 * frontend has exactly one error branch to handle.
 *
 * TAR-39 owns the final error-code taxonomy; this file fixes the envelope only.
 */
export const ApiErrorDetailSchema = z.object({
  /** Dot-path to the offending field, e.g. `contact.phoneNumber`. */
  path: z.string(),
  message: z.string(),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    /** Stable, machine-readable code. Never localise this; localise `message`. */
    code: z.string().min(1),
    message: z.string().min(1),
    /** Field-level detail, present on validation failures. */
    details: z.array(ApiErrorDetailSchema).optional(),
    /** Correlates the response with the structured log line and the error tracker. */
    requestId: z.string().min(1),
  }),
});

export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
