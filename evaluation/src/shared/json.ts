import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { upstreamContractError } from "./errors.ts";

export interface ReadOptions {
  transientStatuses?: ReadonlySet<number>;
}

// A JSON read bound to one endpoint origin; the transport owns HTTP failures and body limits,
// the contracts own the document's shape.
export type ReadJson = (pathname: string, options?: ReadOptions) => Promise<unknown>;

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw upstreamContractError();
  }
}

export type BoundedJsonRead =
  | { value: unknown }
  | { failure: "unreadable" | "unbounded" | "invalid_json" };

// Reads one record without following a link and without loading more than the bound; the
// caller decides which code and message a failure deserves.
export async function readBoundedJson(file: string, limit: number): Promise<BoundedJsonRead> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { failure: "unreadable" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return { failure: "unbounded" };
    return { value: JSON.parse(await handle.readFile("utf8")) };
  } catch {
    return { failure: "invalid_json" };
  } finally {
    await handle.close();
  }
}
