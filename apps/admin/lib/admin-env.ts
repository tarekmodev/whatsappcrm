/**
 * The one place this app reads its own environment.
 *
 * `apps/web`'s `webEnv` is imported for the values both apps share — the API base
 * URL, the mock-transport flag — and this module adds only what the operator
 * console has of its own. Two readers rather than a fork, so a variable neither
 * app renamed cannot mean two things.
 */

export const DEPLOYMENT_ENVIRONMENTS = ['production', 'staging', 'development'] as const;
export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export interface AdminEnv {
  /**
   * Which deployment this build is, for the bar's environment marker.
   *
   * **Build-time, never from an API** (0002 spec §2.1). The badge answers "am I
   * about to suspend a real customer", and a value fetched from the environment
   * it is describing is a value that reads `Staging` when the fetch fails.
   *
   * Public, and correctly so: it names the deployment an operator is already
   * looking at. Unrecognised values fall back to `development` rather than
   * throwing — a badge is not worth refusing to boot over, and `development` is
   * the reading that makes an operator check rather than trust.
   */
  readonly deployment: DeploymentEnvironment;
}

function readDeployment(rawValue: string | undefined): DeploymentEnvironment {
  const value = (rawValue ?? '').trim().toLowerCase();

  return DEPLOYMENT_ENVIRONMENTS.find((name) => name === value) ?? 'development';
}

function readAdminEnv(): AdminEnv {
  return {
    // Referenced literally: `NEXT_PUBLIC_*` values are inlined at build time and
    // a computed `process.env[key]` is never replaced.
    deployment: readDeployment(process.env.NEXT_PUBLIC_ADMIN_DEPLOYMENT),
  };
}

export const adminEnv: AdminEnv = readAdminEnv();
