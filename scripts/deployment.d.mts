// Types for the deployment script's exports that the evaluation module consumes. The script
// stays JavaScript; the module's integration tests prove these declarations against its behaviour.
import type { ReleaseManifest } from "./release.mjs";

export interface DeploymentCommandResult {
  stdout: string;
  exitCode: number;
}

export type DeploymentExecute = (
  command: string,
  args: readonly string[],
  options: { timeoutMilliseconds: number; maxBufferBytes: number; input?: string },
) => Promise<DeploymentCommandResult>;

export interface DeploymentStatusDependencies {
  repositoryRoot?: string;
  release?: ReleaseManifest;
  releasePath?: string;
  execute?: DeploymentExecute;
}

export class DeploymentContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function verifyDeploymentStatus(
  profileName: string,
  context: string,
  dependencies?: DeploymentStatusDependencies,
): Promise<unknown>;
