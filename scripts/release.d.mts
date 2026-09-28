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
