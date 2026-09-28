import type { ReleaseManifest } from "../release.mjs";

export interface ReleaseFixtureOptions {
  platforms?: string[];
  configArchitecture?: string;
  user?: string;
  runtimeRevision?: string;
}

export interface ReleaseFixture {
  bundle: string;
  release: string;
  manifest: ReleaseManifest;
  files: Record<string, string>;
  save: () => void;
}

export function createReleaseFixture(
  bundle: string,
  revision: string,
  options?: ReleaseFixtureOptions,
): ReleaseFixture;

export function gitFixtureEnvironment(
  directory: string,
  revision: string,
  dirty?: boolean,
): { PATH: string };
