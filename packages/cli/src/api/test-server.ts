/**
 * The in-process server the server commands' tests run against
 * (docs/spec/cli-api.md, Testing): `@aumohta/server` over a temporary SQLite
 * database and storage directory on an ephemeral port, and a config
 * directory of its own, so tests never touch the user's profiles.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, startServer, type RunningServer } from "@aumohta/server";
import { main, type Io } from "../cli.js";
import { configPath, type Config } from "./config.js";

export interface CliRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface CliOptions {
  /** What stdin holds; empty when left out. */
  readonly stdin?: string;
  /** Answers to terminal prompts, in order; without them there is no terminal. */
  readonly answers?: readonly string[];
  /** Added to the environment. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface TestServer {
  readonly url: string;
  readonly running: RunningServer;
  /** The environment the CLI runs with: its config directory, and the server as AUMOHTA_SERVER. */
  readonly env: Readonly<Record<string, string>>;
  readonly configFile: string;
  /** Runs `aumohta ...argv` against this server. */
  cli(argv: readonly string[], options?: CliOptions): Promise<CliRun>;
  /** The config file's contents; undefined while there is none. */
  config(): Promise<Config | undefined>;
  close(): Promise<void>;
}

export async function startTestServer(options: { readonly tickCostCheck?: boolean } = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), "aumohta-cli-server-"));
  const quiet = { info: () => undefined, error: () => undefined };
  const running = await startServer(
    {
      ...defaultConfig,
      host: "127.0.0.1",
      port: 0,
      databasePath: join(dir, "aumohta.db"),
      storage: { kind: "local", directory: join(dir, "objects") },
      features: { ...defaultConfig.features, tickCostCheck: options.tickCostCheck ?? false },
    },
    { logger: quiet },
  );
  const configDir = join(dir, "config");
  const env = { APPDATA: configDir, XDG_CONFIG_HOME: configDir, AUMOHTA_SERVER: running.url };
  const configFile = configPath(env);
  return {
    url: running.url,
    running,
    env,
    configFile,
    cli: async (argv, cliOptions = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const answers = [...(cliOptions.answers ?? [])];
      const io: Io = {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        env: { ...env, ...cliOptions.env },
        readStdin: () => Promise.resolve(cliOptions.stdin ?? ""),
        ...(cliOptions.answers === undefined ? {} : { askSecret: () => Promise.resolve(answers.shift() ?? "") }),
      };
      const code = await main(argv, io);
      return { code, out: out.join("\n"), err: err.join("\n") };
    },
    config: async () => {
      try {
        return JSON.parse(await readFile(configFile, "utf8")) as Config;
      } catch {
        return undefined;
      }
    },
    close: async () => {
      await running.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
