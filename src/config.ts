import { z } from "zod";

/**
 * The severity of a rule. Use the strings `"off"`, `"warn"` and `"error"`, or
 * the numbers `0`, `1` and `2`, as in ESLint.
 */
export type Severity = "off" | "warn" | "error" | 0 | 1 | 2;

/**
 * The value of one rule in a config object.
 *
 * - A severity alone (`"error"`) changes the severity and keeps the threshold
 *   from an earlier config object (or the default threshold).
 * - A tuple (`["error", 15]`) sets the severity and the threshold.
 */
export type RuleEntry = Severity | [Severity] | [Severity, number];

/**
 * The rules that you can set in a config object. Each rule compares a metric
 * of each function with a maximum. A function that has a metric larger than
 * the maximum causes a problem.
 */
export interface Rules {
  /** The maximum cognitive complexity (SonarSource) of a function. Default maximum: 15. */
  "cognitive-complexity"?: RuleEntry;
  /** The maximum cyclomatic complexity (McCabe) of a function. Default maximum: 20. */
  "cyclomatic-complexity"?: RuleEntry;
}

/** The name of a rule. */
export type RuleName = keyof Rules;

/**
 * One config object. A config file exports an array of these objects, as in
 * an ESLint flat config.
 *
 * - `files` and `ignores` are minimatch patterns, relative to the directory
 *   of the config file.
 * - A config object that has `files` applies only to files that match one of
 *   the patterns. A config object without `files` applies to all files.
 * - A config object that has only `ignores` (and an optional `name`) sets
 *   global ignores. Global ignore patterns can also match directories
 *   (`"dist/"`).
 * - When more than one config object applies to a file, the later object
 *   overrides the earlier objects.
 */
export interface ConfigObject {
  /** A name for the config object. The CLI shows this name in errors and in `--print-config`. */
  name?: string;
  /**
   * The files that this config object applies to. An item that is an array
   * matches a file only when all of its patterns match the file.
   */
  files?: (string | string[])[];
  /** The files that this config object does not apply to. */
  ignores?: string[];
  /**
   * The cccc language analyzer for the matched files (for example `"es"`,
   * `"rust"`, or an alias such as `"ts"`). If you do not set it, the file
   * extension selects the analyzer.
   */
  language?: string;
  /** The rule settings for the matched files. */
  rules?: Rules;
}

/** A config array: the default export of a `cccc.config.ts` file. */
export type Config = ConfigObject[];

/**
 * Returns the config array without a change. Use it in `cccc.config.ts` to
 * get type checks and editor completion.
 *
 * Nested arrays are flattened, so you can spread or nest shared configs.
 */
export function defineConfig(...configs: (ConfigObject | Config)[]): Config {
  return configs.flat();
}

const severitySchema = z.union([
  z.enum(["off", "warn", "error"]),
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);

const ruleEntrySchema = z.union([
  severitySchema,
  z.tuple([severitySchema]),
  z.tuple([severitySchema, z.number().int().nonnegative()]),
]);

const patternSchema = z.string().min(1);

const configObjectSchema = z.strictObject({
  name: z.string().optional(),
  files: z.array(z.union([patternSchema, z.array(patternSchema).min(1)])).optional(),
  ignores: z.array(patternSchema).optional(),
  language: z.string().min(1).optional(),
  rules: z
    .strictObject({
      "cognitive-complexity": ruleEntrySchema.optional(),
      "cyclomatic-complexity": ruleEntrySchema.optional(),
    })
    .optional(),
});

/** The zod schema of a config array. */
export const configSchema = z.array(configObjectSchema);

/**
 * Parses an unknown value (for example the default export of a config file)
 * into a config array. A nested array is flattened before the check.
 *
 * @throws {ConfigError} when the value is not a valid config array.
 */
export function parseConfig(value: unknown, source = "config"): Config {
  const input = Array.isArray(value) ? value.flat(Infinity) : value;
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(`Invalid ${source}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** An error in a config file or in a config array. */
export class ConfigError extends Error {
  override name = "ConfigError";
}
