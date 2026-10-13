import { opendir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Minimatch } from "minimatch";
import type { ConfigArray } from "./config-array.ts";

/** A file that discovery found. */
export interface FoundFile {
  /** The absolute path. */
  path: string;
  /** The POSIX path relative to the base directory of the config. */
  relativePath: string;
  /** True when the command line named the file directly (not through a directory or a glob). */
  explicit: boolean;
}

/** An error when a pattern from the command line does not match a file. */
export class NoFilesError extends Error {
  override name = "NoFilesError";
}

/** The options of {@link findFiles}. */
export interface FindFilesOptions {
  /** File paths, directory paths, or glob patterns, relative to `cwd`. */
  patterns: readonly string[];
  /** The directory that resolves relative patterns. */
  cwd: string;
  /** The directory that config patterns are relative to. */
  baseDir: string;
  configs: ConfigArray;
}

/**
 * Finds the files to analyze, in a stable order and with no duplicates.
 *
 * - A directory is walked recursively. Ignored directories are not entered,
 *   and only files that the config selects are returned.
 * - A file is always returned, with `explicit: true`, so that the caller can
 *   report why it is not analyzed.
 * - Any other pattern is a glob relative to `cwd`.
 *
 * @throws {NoFilesError} when a path does not exist, or a glob matches no files.
 */
export async function findFiles(options: FindFilesOptions): Promise<FoundFile[]> {
  const { cwd, baseDir, configs } = options;
  const found = new Map<string, FoundFile>();
  function toRelative(path: string): string {
    return toPosix(relative(baseDir, path));
  }
  function add(path: string, explicit: boolean): void {
    if (!found.has(path)) {
      found.set(path, { path, relativePath: toRelative(path), explicit });
    }
  }

  for (const pattern of options.patterns) {
    const absolute = resolve(cwd, pattern);
    const stats = await stat(absolute).catch(() => undefined);

    if (stats?.isFile()) {
      add(absolute, true);
    } else if (stats?.isDirectory()) {
      for await (const file of walk(absolute, toRelative, configs)) {
        add(file, false);
      }
    } else {
      for (const file of await expandGlob(pattern, cwd, toRelative, configs)) {
        add(file, false);
      }
    }
  }

  return [...found.values()];
}

async function expandGlob(
  pattern: string,
  cwd: string,
  toRelative: (path: string) => string,
  configs: ConfigArray,
): Promise<string[]> {
  const matcher = new Minimatch(toPosix(pattern), { dot: true });
  if (!matcher.hasMagic()) {
    throw new NoFilesError(`No such file or directory: "${pattern}".`);
  }
  const files: string[] = [];
  for await (const file of walk(cwd, toRelative, configs)) {
    if (matcher.match(toPosix(relative(cwd, file)))) {
      files.push(file);
    }
  }
  if (files.length === 0) {
    throw new NoFilesError(`No files match the pattern "${pattern}".`);
  }
  return files;
}

async function* walk(
  dir: string,
  toRelative: (path: string) => string,
  configs: ConfigArray,
): AsyncGenerator<string> {
  const relativeDir = toRelative(dir);
  if (relativeDir !== "" && configs.isDirectoryIgnored(relativeDir)) {
    return;
  }
  const entries = [];
  for await (const entry of await opendir(dir)) {
    entries.push(entry);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path, toRelative, configs);
    } else if (
      (entry.isFile() || (entry.isSymbolicLink() && (await isFile(path)))) &&
      configs.isFileSelected(toRelative(path))
    ) {
      yield path;
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => undefined);
  return stats?.isFile() ?? false;
}

/** Converts a native path to a POSIX path. */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
