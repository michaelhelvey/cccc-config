import { CString, dlopen, FFIType, ptr, suffix, type FFIFunction, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

/** Complexity metrics of one function-like unit (function, method, arrow, accessor). */
export interface FunctionReport {
  name: string;
  /** The kind of unit, as the language adapter names it (for example `"method"`). */
  kind: string;
  /** The 1-based line where the unit starts. */
  line: number;
  cognitive: number;
  cyclomatic: number;
  /** Functions that are inside this function. Their scores are not part of this score. */
  children: FunctionReport[];
}

/** Complexity metrics of one source file. */
export interface FileReport {
  path: string;
  /** The total of module-level code and all functions, at all depths. */
  cognitive: number;
  cyclomatic: number;
  functions: FunctionReport[];
  /** Messages from the parser. When there are messages, the metrics can be incomplete. */
  parseErrors: string[];
}

/** One language that the engine can analyze. */
export interface LanguageInfo {
  /** The canonical name, for example `"es"` or `"rust"`. */
  name: string;
  aliases: string[];
  /** The file extensions (without the dot) that select this language by default. */
  extensions: string[];
}

/** A file to analyze, and the language analyzer to use for it. */
export interface FileRequest {
  /** An absolute path. */
  path: string;
  language: string;
}

/** The result of the analysis of one file. */
export type FileOutcome =
  { ok: true; language: string; report: FileReport } | { ok: false; path: string; error: string };

/**
 * The complexity engine. The default implementation calls the cccc Rust
 * library through `bun:ffi`. Supply a different implementation to test code
 * that uses the engine.
 */
export interface ComplexityEngine {
  /** Returns the languages that the engine can analyze. */
  languages(): LanguageInfo[];
  /** Reads and analyzes files in parallel. Returns one outcome per request, in order. */
  analyzeFiles(files: FileRequest[]): FileOutcome[];
  /**
   * Analyzes source text. `path` is a label, and some analyzers use its
   * extension as a hint (for example `.tsx`).
   */
  analyzeSource(source: string, options: { language: string; path: string }): FileReport;
}

/** An error from the native library. */
export class NativeError extends Error {
  override name = "NativeError";
}

/** The environment variable that can set the path of the native library. */
export const LIBRARY_PATH_ENV = "CCCC_FFI_LIBRARY";

const functionReportSchema: z.ZodType<FunctionReport> = z.lazy(() =>
  z.object({
    name: z.string(),
    kind: z.string(),
    line: z.number(),
    cognitive: z.number(),
    cyclomatic: z.number(),
    children: z.array(functionReportSchema).default([]),
  }),
);

const fileReportSchema = z
  .object({
    path: z.string(),
    cognitive: z.number(),
    cyclomatic: z.number(),
    functions: z.array(functionReportSchema),
    parse_errors: z.array(z.string()).default([]),
  })
  .transform(({ parse_errors, ...rest }): FileReport => ({ ...rest, parseErrors: parse_errors }));

const languageSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
  extensions: z.array(z.string()),
});

const fileOutcomeSchema = z.union([
  z
    .object({ language: z.string(), report: fileReportSchema })
    .transform((o) => ({ ok: true as const, ...o })),
  z
    .object({ path: z.string(), error: z.string() })
    .transform((o) => ({ ok: false as const, ...o })),
]);

const versionSchema = z.object({ ffi: z.string(), cccc: z.string() });

const envelopeSchema = z.union([z.object({ ok: z.unknown() }), z.object({ error: z.string() })]);

const symbols = {
  cccc_version: { args: [], returns: FFIType.ptr },
  cccc_languages: { args: [], returns: FFIType.ptr },
  cccc_analyze_source: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  cccc_analyze_files: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  cccc_string_free: { args: [FFIType.ptr], returns: FFIType.void },
} satisfies Record<string, FFIFunction>;

type Library = ReturnType<typeof dlopen<typeof symbols>>;

/** The platforms that have a prebuilt library package, as `${process.platform}-${process.arch}`. */
export const PREBUILT_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;

/** Returns the name of the package that has the prebuilt library for a platform. */
export function prebuiltPackageName(platform: string, arch: string): string {
  return `@michaelhelvey/cccc-config-${platform}-${arch}`;
}

/** The environment of {@link resolveLibraryPath}. Tests can replace each part. */
export interface LibraryLookup {
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  /** The cargo build output in this package. */
  localBuild: string;
  exists(path: string): boolean;
  /** Returns the path of the `package.json` of a package, or `undefined` when it is not installed. */
  resolvePackageJson(name: string): string | undefined;
}

const defaultLookup: LibraryLookup = {
  env: process.env,
  platform: process.platform,
  arch: process.arch,
  localBuild: join(import.meta.dir, "..", "native", "target", "release", `libcccc_ffi.${suffix}`),
  exists: existsSync,
  resolvePackageJson(name) {
    try {
      return Bun.resolveSync(`${name}/package.json`, import.meta.dir);
    } catch {
      return undefined;
    }
  },
};

/**
 * Returns the path of the native library. The order is:
 *
 * 1. The `path` argument.
 * 2. The `CCCC_FFI_LIBRARY` environment variable.
 * 3. The cargo build output in this package, when it exists.
 * 4. The library in the prebuilt package for this platform, when it is installed.
 *
 * When there is no library, it returns the path of the cargo build output.
 */
export function resolveLibraryPath(path?: string, lookup: LibraryLookup = defaultLookup): string {
  const explicit = path ?? lookup.env[LIBRARY_PATH_ENV];
  if (explicit !== undefined) {
    return explicit;
  }
  if (lookup.exists(lookup.localBuild)) {
    return lookup.localBuild;
  }
  const manifest = lookup.resolvePackageJson(prebuiltPackageName(lookup.platform, lookup.arch));
  if (manifest !== undefined) {
    const prebuilt = join(dirname(manifest), basename(lookup.localBuild));
    if (lookup.exists(prebuilt)) {
      return prebuilt;
    }
  }
  return lookup.localBuild;
}

/** The complexity engine that calls the cccc Rust library through `bun:ffi`. */
export class NativeEngine implements ComplexityEngine {
  readonly #lib: Library;
  #languages: LanguageInfo[] | undefined;

  /**
   * Loads the native library.
   *
   * @param libraryPath The path of the library. See {@link resolveLibraryPath}.
   * @throws {NativeError} when the library does not exist or does not load.
   */
  constructor(libraryPath?: string) {
    const path = resolveLibraryPath(libraryPath);
    if (!existsSync(path)) {
      throw new NativeError(
        `The cccc native library is not at ${path}, and there is no prebuilt library ` +
          `for ${process.platform}-${process.arch}. ` +
          "Run `bun run build:native` in the @michaelhelvey/cccc-config package " +
          `(this needs a Rust toolchain), or set ${LIBRARY_PATH_ENV}.`,
      );
    }
    this.#lib = dlopen(path, symbols);
  }

  /** Returns the versions of the FFI library and of the cccc engine. */
  version(): z.infer<typeof versionSchema> {
    return this.#call(versionSchema, this.#lib.symbols.cccc_version());
  }

  languages(): LanguageInfo[] {
    this.#languages ??= this.#call(z.array(languageSchema), this.#lib.symbols.cccc_languages());
    return this.#languages;
  }

  analyzeFiles(files: FileRequest[]): FileOutcome[] {
    if (files.length === 0) {
      return [];
    }
    const request = encode({ files });
    return this.#call(
      z.array(fileOutcomeSchema),
      this.#lib.symbols.cccc_analyze_files(ptr(request), request.byteLength),
    );
  }

  analyzeSource(source: string, options: { language: string; path: string }): FileReport {
    const request = encode({ ...options, source });
    return this.#call(
      fileReportSchema,
      this.#lib.symbols.cccc_analyze_source(ptr(request), request.byteLength),
    );
  }

  /** Unloads the native library. Do not use the engine after this call. */
  close(): void {
    this.#lib.close();
  }

  #call<T extends z.ZodType>(schema: T, result: Pointer | bigint | null): z.output<T> {
    if (typeof result !== "number") {
      throw new NativeError("The cccc native library returned an unusable pointer.");
    }
    let json: string;
    try {
      json = new CString(result).toString();
    } finally {
      this.#lib.symbols.cccc_string_free(result);
    }
    const response = envelopeSchema.parse(JSON.parse(json));
    if ("error" in response) {
      throw new NativeError(response.error);
    }
    return schema.parse(response.ok);
  }
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
