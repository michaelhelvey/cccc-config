import { readFileSync } from "node:fs";
import type { ConfigObject } from "./config.ts";

/**
 * Converts one `.gitignore` pattern to a minimatch pattern for `ignores`,
 * with the same rules as `convertIgnorePatternToMinimatch` in `@eslint/compat`.
 *
 * - A pattern without a slash (or with only a trailing slash) matches at all
 *   depths: `dist/` becomes `**\/dist/`.
 * - A leading slash anchors the pattern to the root: `/dist` becomes `dist`.
 * - `!` negates the pattern.
 */
export function convertIgnorePattern(pattern: string): string {
  const negated = pattern.startsWith("!");
  const prefix = negated ? "!" : "";
  const body = (negated ? pattern.slice(1) : pattern).trimEnd();

  if (["", "**", "/**", "**/"].includes(body)) {
    return `${prefix}${body}`;
  }

  const firstSlash = body.indexOf("/");
  const everywhere = firstSlash < 0 || firstSlash === body.length - 1 ? "**/" : "";
  const unanchored = firstSlash === 0 ? body.slice(1) : body;
  const escaped = unanchored.replaceAll(/(?=((?:\\.|[^{(])*))\1([{(])/guy, "$1\\$2");
  const inside = body.endsWith("/**") ? "/*" : "";

  return `${prefix}${everywhere}${escaped}${inside}`;
}

/**
 * Reads a `.gitignore`-style file and returns a global ignores config object.
 * The patterns are relative to the config file, so the ignore file must be in
 * the same directory as `cccc.config.ts`.
 *
 * @param path The absolute path of the ignore file.
 * @param name A name for the config object. The default is the path.
 */
export function includeIgnoreFile(path: string, name?: string): ConfigObject {
  const ignores = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map(convertIgnorePattern);
  return { name: name ?? `ignore file: ${path}`, ignores };
}
