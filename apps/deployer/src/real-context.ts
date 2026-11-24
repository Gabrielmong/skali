import type { DeployerConfig, Paths } from './config.js';
import { History } from './history.js';
import { type OpContext, opSecrets } from './op-context.js';
import { type System, realSystem } from './system.js';

export interface Tokens {
  /** The GitHub token, read when needed (a replaced token file takes effect without a restart). */
  github: () => string;
  api: string;
}

/** The OpContext the service runs with: real history, nssm and HTTP (health check and busy-wait share sys.httpGet). */
export function realContext(
  config: DeployerConfig,
  paths: Paths,
  tokens: Tokens,
  sys: System = realSystem(config.bin),
): OpContext {
  const now = () => new Date();
  // git's safe.directory wants forward slashes.
  const safeRepo = paths.repo.replace(/\\/g, '/');
  const localEnv = (): Record<string, string> => ({
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: safeRepo,
    // A rejected token must fail at once, never wait on a login window or prompt nobody can answer.
    GIT_CONFIG_KEY_1: 'credential.interactive',
    GIT_CONFIG_VALUE_1: 'false',
    GCM_INTERACTIVE: 'never',
    GIT_TERMINAL_PROMPT: '0',
  });
  const basic = () => Buffer.from(`x-access-token:${tokens.github()}`).toString('base64');

  return {
    config,
    paths,
    sys,
    history: new History(paths.historyFile, paths.eventLogs, config.maxEvents, now),
    gitEnv: () => ({
      ...localEnv(),
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_2: `Authorization: Basic ${basic()}`,
    }),
    gitLocalEnv: localEnv,
    // The base64 Basic value is a secret too: it decodes to the token.
    secrets: () => opSecrets([tokens.github(), tokens.api, basic()]),
    now,
  };
}
