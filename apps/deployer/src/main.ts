import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApi } from './api.js';
import { bootstrapRelease, holdSignals, parseCliArgs } from './bootstrap.js';
import { type DeployerConfig, type Paths, loadConfig, pathsFor } from './config.js';
import { Deployer } from './deployer.js';
import { GitHub } from './github.js';
import { readLogFrom } from './history.js';
import { realContext } from './real-context.js';
import { recoverOnStart } from './recover.js';
import { watchStart } from './watch-start.js';

// Installed as <root>\deployer\app\dist\main.js, so the default config is <root>\deployer\deployer.json.
// `main.js [config]` runs the service; `main.js <config> --bootstrap <sha> --from <dir>` is setup's one-time bootstrap.
const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseCliArgs(process.argv.slice(2));
const configFile = args.config ?? process.env.SKALI_DEPLOYER_CONFIG ?? path.resolve(here, '..', '..', 'deployer.json');

const readToken = (file: string) => readFileSync(file, 'utf8').trim();

/** A missing GitHub token must not stop the helper: GitHub calls then fail as "GitHub token missing". */
const githubToken = (file: string) => () => {
  try {
    return readToken(file);
  } catch {
    return '';
  }
};

/**
 * install-deployer.ps1's bootstrap, run once from an elevated shell while SkaliDeployer is not running. Streams the
 * event's (redacted) log to stdout; exit code 0 only when the new release passed its health check.
 */
async function runBootstrap(config: DeployerConfig, paths: Paths, sha: string, from: string): Promise<number> {
  const base = realContext(config, paths, { github: githubToken(config.tokenFile), api: readToken(config.apiTokenFile) });
  await recoverOnStart(base); // closes events an interrupted earlier run left RUNNING
  const { ctx, started } = watchStart(base);
  const releaseSignals = holdSignals(process, (m) => console.log(m));
  const done = bootstrapRelease(ctx, sha, from);
  let id: string | undefined;
  let offset = 0;
  const pump = () => {
    if (id === undefined) return;
    const chunk = readLogFrom(paths.eventLogs, id, offset);
    if (chunk) {
      process.stdout.write(chunk.log);
      offset = chunk.next;
    }
  };
  void started.then((eventId) => (id = eventId));
  const timer = setInterval(pump, 500);
  try {
    const ev = await done;
    id = ev.id;
    pump();
    if (ev.status === 'SUCCEEDED') {
      console.log(`Bootstrap succeeded: Skali runs ${sha.slice(0, 7)} from ${paths.current}`);
      return 0;
    }
    console.error(`Bootstrap failed: ${ev.detail ?? 'unknown error'}`);
    return 1;
  } finally {
    clearInterval(timer);
    releaseSignals();
  }
}

async function main(): Promise<void> {
  const config = loadConfig(configFile);
  if (args.bootstrap) {
    const paths = pathsFor(config.root);
    process.exit(await runBootstrap(config, paths, args.bootstrap.sha, args.bootstrap.from));
  }
  const paths = pathsFor(config.root);
  const ctx = realContext(config, paths, { github: githubToken(config.tokenFile), api: readToken(config.apiTokenFile) });
  await recoverOnStart(ctx);

  const github = new GitHub(config.githubRepo, config.tokenFile);
  const deployer = new Deployer(ctx, github);
  const server: Server = await startApi(deployer, {
    token: readToken(config.apiTokenFile),
    logsDir: paths.eventLogs,
    port: config.apiPort,
  });
  deployer.start();
  console.log(`SkaliDeployer listening on 127.0.0.1:${config.apiPort}`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('SkaliDeployer stopping; waiting for the current operation');
    server.close();
    await deployer.stop(); // never mid-operation: waits up to 10 min
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e: unknown) => {
  console.error(args.bootstrap ? 'Bootstrap failed:' : 'SkaliDeployer failed to start:', e);
  process.exit(1);
});
