import type { CliEnv } from './context.js';
import { environmentPrepare, environmentPlan, environmentRun, environmentRemove, environmentSamples } from './commands/environment.js';
import { frameworkPrepare } from './commands/framework.js';
import { CliError, EXIT } from './errors.js';
import { authSetToken } from './commands/auth.js';
import { contributionReview } from './commands/contribution.js';
import { MCP_CLIENTS, mcpAdd } from './commands/mcp.js';
import { projectExport } from './commands/project.js';
import { reportCompare, reportExport, reportShow, reportSubmit, reportTrace } from './commands/report.js';
import { runtimeDiscover } from './commands/runtime.js';
import { testPlan } from './commands/test-plan.js';
import { testRun } from './commands/test-run.js';
import { RUNNER_VERSION } from './version.js';

export const HELP = `localfirstdotsh ${RUNNER_VERSION}

Usage:
  localfirstdotsh mcp add [--client ${MCP_CLIENTS.join('|')}] [--registry <url>] [--name <name>] [--scope <scope>] [--print]
  localfirstdotsh environment samples
  localfirstdotsh environment prepare <project-id> --version <id> --environment <key> --out <new-dir>
  localfirstdotsh environment prepare --sample bakery|florist|print-shop|bike-repair|pet-grooming --out <new-dir>
  localfirstdotsh environment plan <workspace> --runtime ollama|lmstudio --model <id> [--framework <artifact>] [--input <private-json>] [--data <private-data-json>]
  localfirstdotsh environment run <plan-file> [--offline]
  localfirstdotsh environment remove <unchanged-prepared-workspace>
  localfirstdotsh framework prepare --workspace <prepared-dir> --out <new-artifact.json>
  localfirstdotsh project export <project-id> [--version <id>] [--test <key>] [--out <dir>] [--registry <url>]
  localfirstdotsh runtime discover --runtime ollama|lmstudio [--endpoint <loopback-url>]
  localfirstdotsh test plan <project-id> --test <key> --runtime ollama|lmstudio --model <id> [--bundle <dir>] [--registry <url>]
  localfirstdotsh test run <plan-file> [--remember] [--offline]
  localfirstdotsh report show <report> [--outputs]
  localfirstdotsh report trace <report> --workspace <bundle-dir> --out <new-file> [--format html|json] [--include-private]
  localfirstdotsh report compare <report-a> <report-b> [--varies model,hardware]
  localfirstdotsh report export <report> --review [--test-definition-id <id>] [--model-source-url <https-url>]
  localfirstdotsh report submit <export-file> [--registry <url>]
  localfirstdotsh contribution review <draft-id> [--registry <url>] [--open]
  localfirstdotsh auth set-token [--registry <url> | --lmstudio-endpoint <url>]

The registry URL comes from --registry or LOCALFIRST_REGISTRY; there is no default.
Nothing runs on its own: no telemetry, downloads, update checks, or background service.
Every approval is interactive and bound to an exact digest; there is no --yes.
`;

type Handler = (env: CliEnv, argv: string[]) => Promise<number>;

const COMMANDS: Record<string, Record<string, Handler>> = {
  framework: { prepare: frameworkPrepare },
  environment: { samples: environmentSamples, prepare: environmentPrepare, plan: environmentPlan, run: environmentRun, remove: environmentRemove },
  project: { export: projectExport },
  runtime: { discover: runtimeDiscover },
  test: { plan: testPlan, run: testRun },
  report: { show: reportShow, trace: reportTrace, compare: reportCompare, export: reportExport, submit: reportSubmit },
  contribution: { review: contributionReview },
  auth: { 'set-token': authSetToken },
  mcp: { add: mcpAdd },
};

/** Run one command line. Returns the process exit code; never throws for expected failures. */
export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const [group, command, ...rest] = argv;
  try {
    if (!group || group === 'help' || group === '--help' || group === '-h') {
      env.io.out(HELP);
      return EXIT.ok;
    }
    if (group === '--version' || group === '-v') {
      env.io.out(`${RUNNER_VERSION}\n`);
      return EXIT.ok;
    }
    const handler = COMMANDS[group]?.[command ?? ''];
    if (!handler) {
      throw new CliError(`Unknown command: ${[group, command].filter(Boolean).join(' ')}\n\n${HELP}`, EXIT.usage);
    }
    return await handler(env, rest);
  } catch (cause) {
    if (cause instanceof CliError) {
      env.io.err(`${cause.message}\n`);
      return cause.exitCode;
    }
    env.io.err(`Unexpected error: ${(cause as Error).message}\n`);
    return EXIT.failed;
  }
}
