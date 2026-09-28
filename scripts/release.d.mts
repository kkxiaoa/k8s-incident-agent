// Types for the release script's exports that the evaluation module consumes. The script stays
// JavaScript; the module's integration tests prove these declarations against its behaviour.
export type ReleaseComponent = "console" | "runtime";

export interface ReleaseImage {
  repository: string;
  indexDigest: string;
  platforms: Record<string, string>;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  sourceRevision: string;
  images: Record<ReleaseComponent, ReleaseImage>;
}

export class ReleaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function loadRelease(
  releasePath: string | undefined,
  repositoryRoot: string,
): Promise<ReleaseManifest>;
