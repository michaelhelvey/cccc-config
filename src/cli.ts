import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { analyze, loadConfig } from "./analyze.ts";
import { ConfigError } from "./config.ts";
import { NoFilesError, toPosix } from "./files.ts";
import { format, FORMATS } from "./formatters.ts";
import { NativeEngine, NativeError, type ComplexityEngine } from "./native.ts";

/** The text that `--help` shows. */
export const HELP = `Usage: cccc-config [options] [file|dir|glob ...]

Measure cognitive and cyclomatic complexity with cccc, configured by cccc.config.ts.

Options:
  -c, --config <path>       Use this config file instead of the nearest cccc.config.ts
      --no-config-lookup    Do not use a config file
  -f, --format <name>       Output format: ${FORMATS.join(", ")} (default: stylish)
      --top <n>             Rows in the table format (default: 20)
      --quiet               Report errors only
      --max-warnings <n>    Fail when there are more than n warnings
      --print-config <file> Print the resolved config for a file, then exit
      --languages           Print the supported languages, then exit
      --color / --no-color  Force colors on or off
  -v, --version             Print the version, then exit
  -h, --help                Print this help, then exit

Exit codes: 0 = no errors, 1 = errors or too many warnings, 2 = fatal error.
`;

/** The environment of a CLI run. Tests supply their own values. */
export interface CliContext {
  cwd: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** True when the output stream supports colors. */
  isTTY: boolean;
  /** Makes the complexity engine. Called at most once. */
  createEngine?: () => ComplexityEngine;
}

const nonNegativeInt = z.coerce.number().int().nonnegative();

const optionsSchema = z.object({
  config: z.string().optional(),
  "no-config-lookup": z.boolean().default(false),
  format: z.enum(FORMATS).default("stylish"),
  top: nonNegativeInt.optional(),
  quiet: z.boolean().default(false),
  "max-warnings": nonNegativeInt.optional(),
  "print-config": z.string().optional(),
  languages: z.boolean().default(false),
  color: z.boolean().optional(),
  "no-color": z.boolean().default(false),
  version: z.boolean().default(false),
  help: z.boolean().default(false),
});

type CliOptions = z.output<typeof optionsSchema>;

/** Runs the CLI with arguments (without the executable and script). Returns the exit code. */
export async function runCli(argv: readonly string[], context: CliContext): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        "no-config-lookup": { type: "boolean" },
        format: { type: "string", short: "f" },
        top: { type: "string" },
        quiet: { type: "boolean" },
        "max-warnings": { type: "string" },
        "print-config": { type: "string" },
        languages: { type: "boolean" },
        color: { type: "boolean" },
        "no-color": { type: "boolean" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
    const parsed = optionsSchema.safeParse(values);
    if (!parsed.success) {
      context.stderr.write(
        `cccc-config: invalid options:\n${z.prettifyError(parsed.error)}\n\n${HELP}`,
      );
      return 2;
    }
    return await dispatch(parsed.data, positionals, context);
  } catch (error) {
    if (isUserError(error)) {
      context.stderr.write(`cccc-config: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

async function dispatch(
  options: CliOptions,
  patterns: string[],
  context: CliContext,
): Promise<number> {
  if (options.help) {
    context.stdout.write(HELP);
    return 0;
  }
  const engine = (context.createEngine ?? (() => new NativeEngine()))();
  if (options.version) {
    return printVersion(engine, context);
  }
  if (options.languages) {
    return printLanguages(engine, context);
  }
  const configFile = options["no-config-lookup"] ? false : options.config;
  if (options["print-config"] !== undefined) {
    return printConfig(options["print-config"], configFile, engine, context);
  }
  return runAnalysis(options, patterns, configFile, engine, context);
}

async function runAnalysis(
  options: CliOptions,
  patterns: string[],
  configFile: string | false | undefined,
  engine: ComplexityEngine,
  context: CliContext,
): Promise<number> {
  const result = await analyze({
    cwd: context.cwd,
    patterns: patterns.length > 0 ? patterns : ["."],
    configFile,
    engine,
  });

  const color = options["no-color"] ? false : (options.color ?? context.isTTY);
  context.stdout.write(
    format(result, options.format, { color, quiet: options.quiet, top: options.top }),
  );

  const maxWarnings = options["max-warnings"];
  if (result.errorCount > 0) {
    return 1;
  }
  if (maxWarnings !== undefined && result.warningCount > maxWarnings) {
    context.stderr.write(
      `cccc-config found too many warnings (${result.warningCount}; maximum: ${maxWarnings}).\n`,
    );
    return 1;
  }
  return 0;
}

async function printVersion(engine: ComplexityEngine, context: CliContext): Promise<number> {
  const pkg = z.object({ version: z.string() }).parse(await import("../package.json"));
  const engineVersion = engine instanceof NativeEngine ? ` (cccc ${engine.version().cccc})` : "";
  context.stdout.write(`cccc-config ${pkg.version}${engineVersion}\n`);
  return 0;
}

function printLanguages(engine: ComplexityEngine, context: CliContext): number {
  for (const language of engine.languages()) {
    const aliases = language.aliases.length > 0 ? ` (${language.aliases.join(", ")})` : "";
    const extensions = language.extensions.map((e) => `.${e}`).join(" ");
    context.stdout.write(`${language.name}${aliases}: ${extensions}\n`);
  }
  return 0;
}

async function printConfig(
  path: string,
  configFile: string | false | undefined,
  engine: ComplexityEngine,
  context: CliContext,
): Promise<number> {
  const loaded = await loadConfig({ cwd: context.cwd, configFile }, engine.languages());
  const file = toPosix(relative(loaded.baseDir, resolve(context.cwd, path)));
  const config = loaded.configs.getConfigForFile(file);
  const language = config && loaded.languageFor(file, config);
  context.stdout.write(`${JSON.stringify(config ? { ...config, language } : null, null, 2)}\n`);
  return 0;
}

function isUserError(error: unknown): error is Error {
  return (
    error instanceof ConfigError ||
    error instanceof NativeError ||
    error instanceof NoFilesError ||
    (error instanceof TypeError && "code" in error)
  );
}
