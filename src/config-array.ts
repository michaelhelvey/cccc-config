import { Minimatch, type MinimatchOptions } from "minimatch";
import type { Config, ConfigObject, RuleEntry, RuleName, Severity } from "./config.ts";

/** A rule severity after normalization. */
export type NormalizedSeverity = "off" | "warn" | "error";

/** The settings of one rule for one file. */
export interface ResolvedRule {
  severity: NormalizedSeverity;
  max: number;
}

/** The merged configuration that applies to one file. */
export interface ResolvedFileConfig {
  /** The language from the config, if a config object sets one. */
  language: string | undefined;
  rules: Record<RuleName, ResolvedRule>;
}

/** The rule settings that apply before any config object. */
export const DEFAULT_RULES: Readonly<Record<RuleName, ResolvedRule>> = {
  "cognitive-complexity": { severity: "error", max: 15 },
  "cyclomatic-complexity": { severity: "off", max: 20 },
};

/** The global ignore patterns that always apply, before the patterns of the config. */
export const DEFAULT_IGNORES: readonly string[] = ["**/node_modules/", ".git/"];

const MATCH_OPTIONS: MinimatchOptions = { dot: true, allowWindowsEscape: true };

/**
 * Applies a config array to paths, with the same matching rules as an ESLint
 * flat config. All paths are POSIX paths relative to the base directory (the
 * directory of the config file).
 */
export class ConfigArray {
  readonly #configs: readonly ConfigObject[];
  readonly #globalIgnores: readonly string[];
  readonly #defaultFiles: readonly string[];

  /**
   * @param configs The config objects, in order.
   * @param defaultFiles The `files` patterns that select files when no config
   *   object selects them, for example `["**\/*.ts"]`.
   */
  constructor(configs: Config, defaultFiles: readonly string[]) {
    this.#configs = configs.filter((c) => !isGlobalIgnore(c));
    this.#globalIgnores = [
      ...DEFAULT_IGNORES,
      ...configs.filter(isGlobalIgnore).flatMap((c) => c.ignores ?? []),
    ];
    this.#defaultFiles = defaultFiles;
  }

  /**
   * Returns true when the global ignores exclude a directory, or when the
   * directory is not in the base directory. A walker can skip all of the
   * contents of an ignored directory.
   */
  isDirectoryIgnored(relativeDir: string): boolean {
    if (isOutside(relativeDir)) {
      return true;
    }
    const parts = relativeDir.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      if (lastMatch(this.#globalIgnores, `${parts.slice(0, i).join("/")}/`)) {
        return true;
      }
    }
    return false;
  }

  /** Returns true when the global ignores exclude a file or one of its parent directories. */
  isFileIgnored(relativePath: string): boolean {
    if (isOutside(relativePath)) {
      return true;
    }
    const dir = relativePath.split("/").slice(0, -1).join("/");
    return (
      (dir !== "" && this.isDirectoryIgnored(dir)) || lastMatch(this.#globalIgnores, relativePath)
    );
  }

  /**
   * Returns true when the config selects a file for analysis: the file is not
   * ignored, and a default pattern or a non-universal `files` pattern of a
   * config object matches it.
   */
  isFileSelected(relativePath: string): boolean {
    if (this.isFileIgnored(relativePath)) {
      return false;
    }
    if (this.#defaultFiles.some((p) => matches(p, relativePath))) {
      return true;
    }
    return this.#configs.some(
      (c) =>
        c.files !== undefined &&
        c.files.some((f) => !isUniversal(f) && matchesFilesItem(f, relativePath)) &&
        !isIgnoredBy(c, relativePath),
    );
  }

  /**
   * Merges every config object that applies to a file. Returns undefined when
   * the config does not select the file.
   */
  getConfigForFile(relativePath: string): ResolvedFileConfig | undefined {
    if (!this.isFileSelected(relativePath)) {
      return undefined;
    }
    const resolved: ResolvedFileConfig = {
      language: undefined,
      rules: {
        "cognitive-complexity": { ...DEFAULT_RULES["cognitive-complexity"] },
        "cyclomatic-complexity": { ...DEFAULT_RULES["cyclomatic-complexity"] },
      },
    };
    for (const config of this.#configs) {
      if (!appliesTo(config, relativePath)) {
        continue;
      }
      resolved.language = config.language ?? resolved.language;
      for (const [name, entry] of Object.entries(config.rules ?? {}) as [RuleName, RuleEntry][]) {
        resolved.rules[name] = mergeRule(resolved.rules[name], entry);
      }
    }
    return resolved;
  }
}

/** Converts a severity to its string form. */
export function normalizeSeverity(severity: Severity): NormalizedSeverity {
  switch (severity) {
    case 0:
      return "off";
    case 1:
      return "warn";
    case 2:
      return "error";
    default:
      return severity;
  }
}

function mergeRule(previous: ResolvedRule, entry: RuleEntry): ResolvedRule {
  if (!Array.isArray(entry)) {
    return { severity: normalizeSeverity(entry), max: previous.max };
  }
  const [severity, max] = entry;
  return { severity: normalizeSeverity(severity), max: max ?? previous.max };
}

function isGlobalIgnore(config: ConfigObject): boolean {
  return (
    config.ignores !== undefined &&
    Object.keys(config).every((key) => key === "ignores" || key === "name")
  );
}

function appliesTo(config: ConfigObject, path: string): boolean {
  if (isIgnoredBy(config, path)) {
    return false;
  }
  return config.files === undefined || config.files.some((f) => matchesFilesItem(f, path));
}

function isIgnoredBy(config: ConfigObject, path: string): boolean {
  return config.ignores !== undefined && lastMatch(config.ignores, path);
}

function matchesFilesItem(item: string | string[], path: string): boolean {
  return typeof item === "string" ? matches(item, path) : item.every((p) => matches(p, path));
}

/**
 * Evaluates ignore patterns in order. A pattern that starts with `!` un-ignores
 * what an earlier pattern ignored.
 */
function lastMatch(patterns: readonly string[], path: string): boolean {
  let ignored = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (ignored && matches(pattern.slice(1), path)) {
        ignored = false;
      }
    } else if (!ignored && matches(pattern, path)) {
      ignored = true;
    }
  }
  return ignored;
}

/** Patterns such as `**`, `src/**` and `src/*` give config, but do not select files. */
function isUniversal(item: string | string[]): boolean {
  return typeof item === "string" ? /(?:^|\/)\*\*?$/.test(item) : item.every(isUniversal);
}

function isOutside(path: string): boolean {
  return path === "" || path === ".." || path.startsWith("../") || path.startsWith("/");
}

const compiled = new Map<string, Minimatch>();

function matches(pattern: string, path: string): boolean {
  let matcher = compiled.get(pattern);
  if (matcher === undefined) {
    matcher = new Minimatch(pattern, MATCH_OPTIONS);
    compiled.set(pattern, matcher);
  }
  return matcher.match(path);
}
