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
