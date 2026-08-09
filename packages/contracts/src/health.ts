import { z } from 'zod';

export const HealthStatusSchema = z.enum(['ok', 'degraded', 'down']);

export const HealthCheckSchema = z.object({
  status: HealthStatusSchema,
  detail: z.string().optional(),
});

/**
 * Shape of `GET /api/health`. TAR-41 populates `checks` with real database and
 * queue probes; the scaffold reports process liveness only.
 */
export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.record(z.string(), HealthCheckSchema),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
