/**
 * Builds the native library when there is no library for this platform. A prebuilt package
 * (`@michaelhelvey/cccc-config-<platform>-<arch>`) makes the build unnecessary.
 *
 * In a git checkout of this package, it always builds, so that the tests use the library of the
 * source and not a prebuilt library from npm.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveLibraryPath } from "../src/native.ts";

const root = join(import.meta.dir, "..");
const checkout = existsSync(join(root, ".git"));
const path = resolveLibraryPath();

if (!checkout && existsSync(path)) {
  console.log(`cccc-config: using the native library at ${path}`);
} else {
  const build = Bun.spawnSync(
    ["cargo", "build", "--release", "--manifest-path", join(root, "native", "Cargo.toml")],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exitCode = build.exitCode;
}
