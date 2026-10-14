# @michaelhelvey/cccc-config

A code complexity checker for TypeScript (and 20 other languages). You configure it with an
ESLint-style flat config in `cccc.config.ts`.

The analysis engine is [cccc](https://github.com/moznion/cccc), a Rust tool that measures:

- **Cognitive complexity** (SonarSource, G. Ann Campbell): how difficult a function is to read.
  Nesting increases the score.
- **Cyclomatic complexity** (McCabe): the number of independent paths through a function.

This package does not start the `cccc` executable. It compiles the cccc Rust crates into a shared
library and calls that library in the same process through [`bun:ffi`](https://bun.sh/docs/api/ffi).
The TypeScript side finds the files, applies the config, checks the rules, and formats the output.
The Rust side parses and scores many files in parallel.

```text
src/legacy/importer.ts
  41  error  Function 'importRows' has a cognitive complexity of 23. Maximum allowed is 15.  cognitive-complexity

✖ 1 problem (1 error, 0 warnings)
```

## Requirements

- macOS or Linux. The package does not support Windows.
- [Bun](https://bun.sh) 1.2 or later. The package uses `bun:ffi`, so it does not run on Node.js.
- A Rust toolchain (`cargo`, 1.95 or later) and a C compiler. The install step compiles the native
  library from source. Some language grammars (tree-sitter, Ruby Prism) contain C code, and the Ruby
  adapter also needs `libclang`.

## Install

```sh
bun add -d @michaelhelvey/cccc-config
```

The `postinstall` script compiles the native library (`cargo build --release`). The first build
takes some minutes. Bun does not run lifecycle scripts of dependencies until you trust them, so add
the package to `trustedDependencies` in your `package.json`:

```json
{
  "trustedDependencies": ["@michaelhelvey/cccc-config"]
}
```

Then install again, or run `bun pm trust @michaelhelvey/cccc-config`.

If you do not want to trust the script, build the library yourself:

```sh
cd node_modules/@michaelhelvey/cccc-config && bun run build:native
```

To use a library that you built in a different location, set `CCCC_FFI_LIBRARY` to its path (for
example `/opt/cccc/libcccc_ffi.dylib`).

## Quick start

Create `cccc.config.ts` in the root of your project:

```ts
import { defineConfig, includeIgnoreFile } from "@michaelhelvey/cccc-config";

export default defineConfig(
  // Use the .gitignore patterns as global ignores.
  includeIgnoreFile(`${import.meta.dir}/.gitignore`),

  // Global ignores: an object with only `ignores`.
  { name: "generated", ignores: ["src/generated/", "**/*.gen.ts"] },

  // Settings for all files.
  {
    name: "defaults",
    rules: {
      "cognitive-complexity": ["error", 15],
      "cyclomatic-complexity": ["warn", 20],
    },
  },

  // Overrides for some files. Later objects override earlier objects.
  {
    name: "legacy code",
    files: ["src/legacy/**"],
    rules: { "cognitive-complexity": ["warn", 30] },
  },

  // Tests: change the severity, but keep the maximum of 15.
  {
    files: ["**/*.test.ts"],
    rules: { "cognitive-complexity": "warn" },
  },
);
```

Run the CLI:

```sh
bunx cccc-config            # analyze the current directory
bunx cccc-config src lib    # analyze some directories
bunx cccc-config "src/**/*.tsx"
```

Add a script to `package.json` to use it in CI:

```json
{
  "scripts": {
    "complexity": "cccc-config --max-warnings 0"
  }
}
```

## Configuration

`cccc.config.ts` (or `.mts`, `.js`, `.mjs`) exports a config array as its default export. The CLI
looks for the file in the current directory, then in each parent directory. All patterns are
relative to the directory of the config file.

The matching rules are the same as in an
[ESLint flat config](https://eslint.org/docs/latest/use/configure/configuration-files):

- `files` and `ignores` use [minimatch](https://github.com/isaacs/minimatch) patterns, with
  `dot: true`. `*.ts` matches only in the root directory. Use `**/*.ts` to match at all depths.
- A config object with `files` applies only to files that match one of its patterns. A config object
  without `files` applies to all files.
- An item in `files` can be an array of patterns. That item matches a file only when all of its
  patterns match.
- `ignores` in a config object that has other keys removes files from that object only.
- A config object that has only `ignores` (and an optional `name`) sets **global ignores**. Global
  ignore patterns can match directories (`"dist/"`), and the CLI does not go into ignored
  directories. A pattern that starts with `!` un-ignores a file. You cannot un-ignore a file in an
  ignored directory, so use `"build/**/*"` and not `"build/**"` if you want to un-ignore a file in
  `build`.
- `**/node_modules/` and `.git/` are always ignored.
- When more than one config object applies to a file, the CLI merges them in order. A later object
  overrides an earlier object.
- A file is analyzed when it has the extension of a supported language, or when a `files` pattern
  that is not universal (`**`, `src/**`, `src/*`) matches it.

### Config object

| Key        | Type                     | Description                                                                                                                  |
| ---------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `name`     | `string`                 | A name for the object. Errors show this name.                                                                                |
| `files`    | `(string \| string[])[]` | The files that the object applies to.                                                                                        |
| `ignores`  | `string[]`               | The files that the object does not apply to, or global ignores.                                                              |
| `language` | `string`                 | The analyzer for the matched files, for example `"go"` for `**/*.tmpl`. If not set, the file extension selects the analyzer. |
| `rules`    | `Rules`                  | The rule settings. See below.                                                                                                |

The CLI rejects unknown keys and unknown languages.

### Rules

| Rule                    | Default         | Measures                                    |
| ----------------------- | --------------- | ------------------------------------------- |
| `cognitive-complexity`  | `["error", 15]` | The cognitive complexity of each function.  |
| `cyclomatic-complexity` | `["off", 20]`   | The cyclomatic complexity of each function. |

A rule causes a problem for each function that has a metric **larger** than the maximum. The CLI
checks each function by itself: a nested function has its own score, and its score is not part of
the score of the function that contains it.

A rule value is one of:

- A severity: `"off"`, `"warn"`, `"error"` (or `0`, `1`, `2`). The rule keeps the maximum from an
  earlier config object, or the default maximum.
- A tuple: `["error", 10]`. This sets the severity and the maximum.

If a parser finds a syntax error in a file, the CLI shows an error for that file. The metrics of
that file can be incomplete.

### Languages

The engine includes all of the cccc languages. Run `bunx cccc-config --languages` to see the list,
the aliases, and the extensions:

```text
es (ecmascript, javascript, typescript, js, ts): .ts .tsx .js .jsx .mts .cts .mjs .cjs
rust (rs): .rs
go (golang): .go
...
```

To analyze only TypeScript in a project that has other languages, add global ignores for the other
extensions, for example `{ ignores: ["**/*.py", "**/*.go"] }`.

## CLI

```text
Usage: cccc-config [options] [file|dir|glob ...]

Options:
  -c, --config <path>       Use this config file instead of the nearest cccc.config.ts
      --no-config-lookup    Do not use a config file
  -f, --format <name>       Output format: stylish, json, table (default: stylish)
      --top <n>             Rows in the table format (default: 20)
      --quiet               Report errors only
      --max-warnings <n>    Fail when there are more than n warnings
      --print-config <file> Print the resolved config for a file, then exit
      --languages           Print the supported languages, then exit
      --color / --no-color  Force colors on or off
  -v, --version             Print the version, then exit
  -h, --help                Print this help, then exit
```

Exit codes:

| Code | Meaning                                                                          |
| ---- | -------------------------------------------------------------------------------- |
| `0`  | No errors, and not more warnings than `--max-warnings`.                          |
| `1`  | One or more errors, or more warnings than `--max-warnings`.                      |
| `2`  | A fatal error: an invalid config, a pattern with no files, or no native library. |

Output formats:

- `stylish` (default): the problems, grouped by file, as in ESLint.
- `table`: the functions with the highest cognitive complexity, and the distribution (sum, max,
  median, p90, p95) of each metric over all functions.
- `json`: the full result, with the metrics of each function and the problems of each file.

If you name a file on the command line and the config ignores it, the CLI shows a warning for that
file.

## API

```ts
import { analyze, NativeEngine } from "@michaelhelvey/cccc-config";

// Analyze a project with its cccc.config.ts.
const result = await analyze({ cwd: "/path/to/project", patterns: ["src"] });
console.log(result.errorCount, result.summary.cognitive.p95);

// Use an inline config. Patterns are relative to `cwd`.
await analyze({ config: [{ rules: { "cognitive-complexity": ["error", 10] } }] });

// Analyze source text with the engine directly.
const engine = new NativeEngine();
const report = engine.analyzeSource("function f(a) { if (a) return 1; }", {
  language: "ts",
  path: "f.ts",
});
console.log(report.functions[0]?.cognitive); // 1
```

Other exports:

- `defineConfig`, `parseConfig`, `configSchema`: write and check config arrays.
- `ConfigArray`: apply a config array to paths (selection, ignores, merged rules).
- `includeIgnoreFile`, `convertIgnorePattern`: use `.gitignore` files as global ignores.
- `format`, `formatStylish`, `formatTable`: format an `AnalysisResult`.
- `ComplexityEngine`: the engine interface. Give your own implementation to `analyze({ engine })`
  for tests.

## How it works

```text
cccc.config.ts ──► ConfigArray ──► file walk (ignored directories are not entered)
                                        │
                                        ▼
                     native/ (Rust cdylib, cccc crates at a pinned git rev)
                     cccc_analyze_files: read + parse + score in parallel (rayon)
                                        │  JSON over bun:ffi
                                        ▼
                     rules per function ──► stylish / table / json
```

- `native/` is a small Rust crate (`cccc-ffi`). It depends on the `cccc-cli` and `cccc-core` crates
  at a pinned git commit and exports a C ABI: `cccc_languages`, `cccc_analyze_files`,
  `cccc_analyze_source`, `cccc_version`, and `cccc_string_free`. Each function takes one JSON
  request and returns one JSON response. A panic in an analyzer becomes an error for that file.
- `src/native.ts` loads the library with `dlopen` and parses each response with zod.
- `src/config-array.ts` contains the flat config logic.

To change the cccc version, change the `rev` in `native/Cargo.toml` and `CCCC_VERSION` in
`native/src/lib.rs`, then run `bun run build:native`.

## Development

```sh
bun install              # also builds the native library
bun run build:native     # build the native library again
bun run build:types      # write the .d.ts files to dist/types (prepack does this)
bun run validate         # format, lint, type check, and test
bun run complexity       # run the CLI on this package
```

The tests in `src/native.test.ts` and `src/cli.test.ts` use the real native library, so build it
before you run `bun test`.

Bun runs the `.ts` files in `src` directly, so the package has no JavaScript build. The package also
contains `.d.ts` files in `dist/types`, and the `types` export condition points to them. Thus the
TypeScript compiler of a consumer checks only the declarations and not the source with the compiler
options of the consumer.
