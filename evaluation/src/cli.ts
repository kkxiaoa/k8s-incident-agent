import path from "node:path";
import { fileURLToPath } from "node:url";

import { runOnlineEvaluation } from "./commands/online.ts";
import { runReportCommand } from "./commands/report.ts";
import { runCatalogEvaluation, type RunRequest } from "./commands/run.ts";
import { EvaluationError, invalidArguments, safeFailure, type SafeFailure } from "./shared/errors.ts";
import { isNormalizedString } from "./shared/guards.ts";

type CliRequest =
  | { action: "run" | "online"; request: RunRequest }
  | { action: "report"; artifactPath: string };

export interface CliOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface EvaluationOutcome {
  artifact: { status: string; profile: string };
  artifactPath: string;
}

export interface CliCommands {
  run: (request: RunRequest) => Promise<EvaluationOutcome>;
  online: (request: RunRequest) => Promise<EvaluationOutcome>;
  report: (artifactPath: string) => Promise<unknown>;
}

type ExitCode = 0 | 1 | 2;

const DEFAULT_COMMANDS: CliCommands = {
  run: runCatalogEvaluation,
  online: runOnlineEvaluation,
  report: runReportCommand,
};

const REPORT_FAILURE: SafeFailure = { code: "evaluation_report_failed", message: "The report could not be produced" };

export function parseArguments(argv: readonly string[]): CliRequest {
  if (argv.length < 2) throw invalidArguments();
  const [action, ...rest] = argv;
  if (action === "report") {
    if (rest.length !== 1) throw invalidArguments();
    return { action, artifactPath: rest[0] };
  }
  if (action !== "run" && action !== "online") throw invalidArguments();
  const [profile, ...options] = rest;
  let context: string | undefined;
  let datasetPath: string | undefined;
  let releasePath: string | undefined;
  let split: string | undefined;
  let retryOf: string | undefined;
  const scenarioIds: string[] = [];
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (!isNormalizedString(value) || value.startsWith("-")) throw invalidArguments();
    if (option === "--context" && context === undefined) context = value;
    else if (option === "--release" && releasePath === undefined) releasePath = value;
    else if (option === "--scenario" && action === "run") scenarioIds.push(value);
    else if (option === "--dataset" && action === "run" && datasetPath === undefined) datasetPath = value;
    else if (option === "--split" && action === "run" && split === undefined) split = value;
    else if (option === "--retry-of" && action === "run" && retryOf === undefined) retryOf = value;
    else throw invalidArguments();
  }
  return {
    action,
    request: {
      profile,
      context,
      datasetPath,
      releasePath,
      split,
      retryOf,
      ...(scenarioIds.length > 0 ? { scenarioIds } : {}),
    },
  };
}

function fail(output: CliOutput, failure: SafeFailure): ExitCode {
  output.stderr(`FAIL ${failure.code} ${failure.message}\n`);
  return 1;
}

export async function runCli(argv: readonly string[], output: CliOutput, commands: CliCommands = DEFAULT_COMMANDS): Promise<ExitCode> {
  let parsed: CliRequest;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    return fail(output, safeFailure(error));
  }
  if (parsed.action === "report") {
    try {
      output.stdout(`${JSON.stringify(await commands.report(parsed.artifactPath), null, 2)}\n`);
      return 0;
    } catch (error) {
      return fail(output, error instanceof EvaluationError ? { code: error.code, message: error.message } : REPORT_FAILURE);
    }
  }
  try {
    const { artifact, artifactPath } = await commands[parsed.action](parsed.request);
    output.stdout(`${JSON.stringify({ status: artifact.status, profile: artifact.profile, artifact: artifactPath })}\n`);
    if (artifact.status === "pending_manual_review") return 2;
    return artifact.status === "passed" ? 0 : 1;
  } catch (error) {
    return fail(output, safeFailure(error));
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}
