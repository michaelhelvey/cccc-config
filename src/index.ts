/**
 * Measure cognitive and cyclomatic complexity with the cccc Rust engine,
 * configured by an ESLint-style flat config in `cccc.config.ts`.
 *
 * @module
 */
export {
  analyze,
  checkRules,
  flattenFunctions,
  loadConfig,
  summarize,
  type AnalysisResult,
  type AnalyzeOptions,
  type FileResult,
  type LoadedConfig,
  type MetricSummary,
  type Problem,
  type Summary,
} from "./analyze.ts";
export {
  ConfigArray,
  DEFAULT_IGNORES,
  DEFAULT_RULES,
  type NormalizedSeverity,
  type ResolvedFileConfig,
  type ResolvedRule,
} from "./config-array.ts";
export {
  ConfigError,
  configSchema,
  defineConfig,
  parseConfig,
  type Config,
  type ConfigObject,
  type RuleEntry,
  type RuleName,
  type Rules,
  type Severity,
} from "./config.ts";
export { findFiles, NoFilesError, type FindFilesOptions, type FoundFile } from "./files.ts";
export {
  format,
  formatStylish,
  formatTable,
  FORMATS,
  type Format,
  type FormatOptions,
} from "./formatters.ts";
export { convertIgnorePattern, includeIgnoreFile } from "./ignore-file.ts";
export { CONFIG_FILE_NAMES, findConfigFile, loadConfigFile } from "./load-config.ts";
export {
  LIBRARY_PATH_ENV,
  NativeEngine,
  NativeError,
  PREBUILT_PLATFORMS,
  prebuiltPackageName,
  resolveLibraryPath,
  type LibraryLookup,
  type ComplexityEngine,
  type FileOutcome,
  type FileReport,
  type FileRequest,
  type FunctionReport,
  type LanguageInfo,
} from "./native.ts";
