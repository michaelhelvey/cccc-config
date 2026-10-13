import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ConfigError, parseConfig, type Config } from "./config.ts";

/** The names of a config file, in the order of the search. */
export const CONFIG_FILE_NAMES: readonly string[] = [
  "cccc.config.ts",
  "cccc.config.mts",
  "cccc.config.js",
  "cccc.config.mjs",
];

/**
 * Finds the nearest config file: it looks in `cwd`, then in each parent
 * directory. Returns undefined when no directory has a config file.
 */
export function findConfigFile(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

const moduleSchema = z.object({ default: z.unknown() });

/**
 * Imports a config file and parses its default export.
 *
 * @throws {ConfigError} when the file does not load, or its default export is not a valid config.
 */
export async function loadConfigFile(path: string): Promise<Config> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(path).href);
  } catch (error) {
    throw new ConfigError(`Cannot load the config file ${path}: ${String(error)}`, {
      cause: error,
    });
  }
  const parsed = moduleSchema.safeParse(module);
  if (!parsed.success || parsed.data.default === undefined) {
    throw new ConfigError(`The config file ${path} has no default export.`);
  }
  return parseConfig(parsed.data.default, `config file ${path}`);
}
