import { dirname, extname, resolve } from "node:path";
import { ConfigArray, type ResolvedFileConfig } from "./config-array.ts";
import { ConfigError, parseConfig, type Config, type RuleName } from "./config.ts";
import { findFiles, type FoundFile } from "./files.ts";
import { findConfigFile, loadConfigFile } from "./load-config.ts";
import {
  NativeEngine,
  type ComplexityEngine,
  type FileReport,
  type FunctionReport,
  type LanguageInfo,
} from "./native.ts";

/** One problem in a file: a rule violation, a parse error, or a note about an ignored file. */
export interface Problem {
  /** The rule that found the problem, or null for parse errors and ignored files. */
  ruleId: RuleName | null;
  severity: "warn" | "error";
  message: string;
  /** The 1-based line, when the problem has a location. */
  line?: number;
  /** The function that has the problem. */
  function?: { name: string; kind: string };
  /** The measured value, for rule violations. */
  value?: number;
  /** The maximum that the rule permits, for rule violations. */
  max?: number;
}

/** The result for one file. */
export interface FileResult {
  /** The absolute path. */
  path: string;
  /** The POSIX path relative to the base directory. */
  relativePath: string;
  /** The canonical name of the language analyzer, or null when the file was not analyzed. */
  language: string | null;
  /** The metrics, or null when the file was not analyzed. */
  report: FileReport | null;
  problems: Problem[];
  errorCount: number;
  warningCount: number;
}

/** The distribution of one metric over all functions. */
export interface MetricSummary {
  sum: number;
  max: number;
  median: number;
  p90: number;
  p95: number;
}

/** A summary of all analyzed files. */
export interface Summary {
  fileCount: number;
  functionCount: number;
  cognitive: MetricSummary;
  cyclomatic: MetricSummary;
}

/** The result of {@link analyze}. */
export interface AnalysisResult {
  /** The directory that config patterns are relative to. */
  baseDir: string;
  /** The config file that was used, if any. */
  configFile: string | undefined;
  files: FileResult[];
  errorCount: number;
  warningCount: number;
  summary: Summary;
}

/** The options of {@link analyze}. */
export interface AnalyzeOptions {
  /** The working directory. Default: `process.cwd()`. */
  cwd?: string;
  /** Files, directories, or globs to analyze, relative to `cwd`. Default: `["."]`. */
  patterns?: readonly string[];
  /**
   * The config file to use. Set `false` to use no config file. Default: the
   * nearest `cccc.config.ts` (or `.mts`, `.js`, `.mjs`) in `cwd` or a parent.
   */
  configFile?: string | false;
  /**
   * A config array to use instead of a config file. Patterns are relative to
   * `cwd`. When you set this option, `configFile` has no effect.
   */
  config?: Config;
  /** The complexity engine. Default: a {@link NativeEngine}. */
  engine?: ComplexityEngine;
}

/** A config array with its base directory and the languages that it can use. */
export interface LoadedConfig {
  configs: ConfigArray;
  baseDir: string;
  configFile: string | undefined;
  /** Finds the canonical language for a file and its resolved config. */
  languageFor(relativePath: string, config: ResolvedFileConfig): string | undefined;
}

/**
 * Loads the config for a run: an inline config, an explicit config file, or
 * the nearest config file.
 *
 * @throws {ConfigError} when the config is not valid, or names an unknown language.
 */
export async function loadConfig(
  options: Pick<AnalyzeOptions, "cwd" | "configFile" | "config">,
  languages: readonly LanguageInfo[],
): Promise<LoadedConfig> {
  const { config, configFile, baseDir } = await readConfig(options);
  const index = indexLanguages(languages);

  for (const object of config) {
    if (object.language !== undefined && !index.byName.has(object.language.toLowerCase())) {
      const where = object.name === undefined ? "" : ` in config "${object.name}"`;
      throw new ConfigError(
        `Unknown language "${object.language}"${where}. ` +
          `Known languages: ${languages.map((l) => l.name).join(", ")}.`,
      );
    }
  }

  const defaultFiles = [...index.byExtension.keys()].map((ext) => `**/*.${ext}`);

  return {
    configs: new ConfigArray(config, defaultFiles),
    baseDir,
    configFile,
    languageFor(relativePath, resolved) {
      if (resolved.language !== undefined) {
        return index.byName.get(resolved.language.toLowerCase());
      }
      return index.byExtension.get(extname(relativePath).slice(1).toLowerCase());
    },
  };
}

async function readConfig(options: Pick<AnalyzeOptions, "cwd" | "configFile" | "config">) {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.config !== undefined) {
    return { config: parseConfig(options.config), configFile: undefined, baseDir: cwd };
  }
  const configFile =
    options.configFile === false
      ? undefined
      : options.configFile === undefined
        ? findConfigFile(cwd)
        : resolve(cwd, options.configFile);
  if (configFile === undefined) {
    return { config: [], configFile, baseDir: cwd };
  }
  return { config: await loadConfigFile(configFile), configFile, baseDir: dirname(configFile) };
}

function indexLanguages(languages: readonly LanguageInfo[]) {
  const byName = new Map<string, string>();
  const byExtension = new Map<string, string>();
  for (const language of languages) {
    for (const name of [language.name, ...language.aliases]) {
      byName.set(name.toLowerCase(), language.name);
    }
    for (const ext of language.extensions.map((e) => e.toLowerCase())) {
      if (!byExtension.has(ext)) {
        byExtension.set(ext, language.name);
      }
    }
  }
  return { byName, byExtension };
}

/**
 * Finds the files, analyzes them with the complexity engine, and checks the
 * rules of the config.
 */
export async function analyze(options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const engine = options.engine ?? new NativeEngine();
  const loaded = await loadConfig({ ...options, cwd }, engine.languages());
  const found = await findFiles({
    patterns: options.patterns ?? ["."],
    cwd,
    baseDir: loaded.baseDir,
    configs: loaded.configs,
  });

  const results: FileResult[] = [];
  const jobs: { file: FoundFile; language: string; config: ResolvedFileConfig }[] = [];

  for (const file of found) {
    const config = loaded.configs.getConfigForFile(file.relativePath);
    const language = config && loaded.languageFor(file.relativePath, config);
    if (config !== undefined && language !== undefined) {
      jobs.push({ file, language, config });
    } else if (file.explicit) {
      results.push(skipped(file, config === undefined ? ignoredReason(loaded, file) : NO_LANGUAGE));
    }
  }

  const outcomes = engine.analyzeFiles(
    jobs.map((j) => ({ path: j.file.path, language: j.language })),
  );

  outcomes.forEach((outcome, i) => {
    const job = jobs[i];
    if (job === undefined) {
      return;
    }
    if (!outcome.ok) {
      results.push(
        withCounts({
          ...base(job.file),
          language: job.language,
          problems: [{ ruleId: null, severity: "error", message: outcome.error }],
        }),
      );
      return;
    }
    const report = { ...outcome.report, path: job.file.relativePath };
    results.push(
      withCounts({
        ...base(job.file),
        language: outcome.language,
        report,
        problems: checkRules(report, job.config),
      }),
    );
  });

  results.sort((a, b) => compare(a.relativePath, b.relativePath));

  return {
    baseDir: loaded.baseDir,
    configFile: loaded.configFile,
    files: results,
    errorCount: results.reduce((n, f) => n + f.errorCount, 0),
    warningCount: results.reduce((n, f) => n + f.warningCount, 0),
    summary: summarize(results),
  };
}

const METRICS: Record<RuleName, { key: "cognitive" | "cyclomatic"; label: string }> = {
  "cognitive-complexity": { key: "cognitive", label: "cognitive complexity" },
  "cyclomatic-complexity": { key: "cyclomatic", label: "cyclomatic complexity" },
};

/**
 * Checks the rules of a resolved config against a file report. Returns one
 * problem for each function and rule where the metric is more than the maximum,
 * plus one problem for each parse error.
 */
export function checkRules(report: FileReport, config: ResolvedFileConfig): Problem[] {
  const problems: Problem[] = report.parseErrors.map((message) => ({
    ruleId: null,
    severity: "error",
    message: `Parsing error: ${message}`,
  }));

  for (const fn of flattenFunctions(report.functions)) {
    for (const [ruleId, { key, label }] of Object.entries(METRICS) as [
      RuleName,
      (typeof METRICS)[RuleName],
    ][]) {
      const rule = config.rules[ruleId];
      const value = fn[key];
      if (rule.severity === "off" || value <= rule.max) {
        continue;
      }
      problems.push({
        ruleId,
        severity: rule.severity,
        message: `${describe(fn)} has a ${label} of ${value}. Maximum allowed is ${rule.max}.`,
        line: fn.line,
        function: { name: fn.name, kind: fn.kind },
        value,
        max: rule.max,
      });
    }
  }

  return problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/** Returns every function in a report tree, parents before children. */
export function flattenFunctions(functions: readonly FunctionReport[]): FunctionReport[] {
  return functions.flatMap((fn) => [fn, ...flattenFunctions(fn.children)]);
}

/** Computes the distribution of each metric over all functions in all files. */
export function summarize(files: readonly FileResult[]): Summary {
  const functions = files.flatMap((f) => (f.report ? flattenFunctions(f.report.functions) : []));
  return {
    fileCount: files.filter((f) => f.report !== null).length,
    functionCount: functions.length,
    cognitive: metricSummary(functions.map((f) => f.cognitive)),
    cyclomatic: metricSummary(functions.map((f) => f.cyclomatic)),
  };
}

function metricSummary(values: number[]): MetricSummary {
  const sorted = values.toSorted((a, b) => a - b);
  function percentile(p: number): number {
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)] ?? 0;
  }
  return {
    sum: sorted.reduce((a, b) => a + b, 0),
    max: sorted.at(-1) ?? 0,
    median: percentile(50),
    p90: percentile(90),
    p95: percentile(95),
  };
}

function describe(fn: FunctionReport): string {
  const kind = fn.kind.charAt(0).toUpperCase() + fn.kind.slice(1);
  return `${kind} '${fn.name}'`;
}

const NO_LANGUAGE = "File ignored because no language analyzer matches it.";

function ignoredReason(loaded: LoadedConfig, file: FoundFile): string {
  return loaded.configs.isFileIgnored(file.relativePath)
    ? "File ignored because of a matching ignore pattern."
    : "File ignored because no matching configuration was supplied.";
}

function skipped(file: FoundFile, message: string): FileResult {
  return withCounts({
    ...base(file),
    language: null,
    problems: [{ ruleId: null, severity: "warn", message }],
  });
}

function base(file: FoundFile) {
  return { path: file.path, relativePath: file.relativePath, report: null };
}

function withCounts(result: Omit<FileResult, "errorCount" | "warningCount">): FileResult {
  return {
    ...result,
    errorCount: result.problems.filter((p) => p.severity === "error").length,
    warningCount: result.problems.filter((p) => p.severity === "warn").length,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
