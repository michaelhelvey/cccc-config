/**
 * Publishes a version of the package and of each prebuilt platform package.
 *
 * Usage: `bun run release <version> <run-id> [--dry-run]`
 *
 * `<run-id>` is a run of the Native workflow (`gh run list --workflow native.yml`). Use a run of the
 * commit that you publish.
 *
 * 1. Downloads the library of each platform from the run.
 * 2. Publishes each platform package (`npm/<platform>`) with the version.
 * 3. Sets the version and the `optionalDependencies` of this package, and updates `bun.lock`.
 * 4. Publishes this package.
 *
 * With `--dry-run`, it publishes nothing and does not change `package.json`.
 *
 * @module
 */
import { $ } from "bun";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PREBUILT_PLATFORMS, prebuiltPackageName } from "../src/native.ts";

const ROOT = join(import.meta.dir, "..");

const manifestSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

/** The library file name of a platform. */
function libraryName(platform: string): string {
  return platform.startsWith("darwin") ? "libcccc_ffi.dylib" : "libcccc_ffi.so";
}

async function readManifest(path: string): Promise<z.infer<typeof manifestSchema>> {
  return manifestSchema.parse(await Bun.file(path).json());
}

async function writeManifest(path: string, manifest: object): Promise<void> {
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [version, runId] = args.filter((a) => a !== "--dry-run");
  if (version === undefined || runId === undefined || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error("Usage: bun run release <version> <run-id> [--dry-run]");
  }
  const publish = dryRun ? ["--dry-run"] : [];

  const artifacts = await mkdtemp(join(tmpdir(), "cccc-release-"));
  await $`gh run download ${runId} --dir ${artifacts}`.cwd(ROOT);

  for (const platform of PREBUILT_PLATFORMS) {
    const dir = join(ROOT, "npm", platform);
    const library = libraryName(platform);
    const artifact = Bun.file(join(artifacts, `libcccc_ffi-${platform}`, library));
    if (!(await artifact.exists())) {
      throw new Error(`Run ${runId} has no library for ${platform}`);
    }
    await Bun.write(join(dir, library), artifact);

    const manifestPath = join(dir, "package.json");
    const manifest = await readManifest(manifestPath);
    await writeManifest(manifestPath, { ...manifest, version });
    await $`npm publish ${publish}`.cwd(dir);
  }

  if (dryRun) {
    console.log(`\nDry run: did not change package.json or publish ${version}.`);
    return;
  }

  const manifestPath = join(ROOT, "package.json");
  const manifest = await readManifest(manifestPath);
  const optionalDependencies = Object.fromEntries(
    PREBUILT_PLATFORMS.map((p) => {
      const [os = "", arch = ""] = p.split("-");
      return [prebuiltPackageName(os, arch), version];
    }),
  );
  await writeManifest(manifestPath, { ...manifest, version, optionalDependencies });
  await $`bun install`.cwd(ROOT);
  await $`npm publish`.cwd(ROOT);

  console.log(`\nPublished ${version}. Commit package.json, bun.lock, and npm/*/package.json.`);
}

try {
  await main();
} catch (e) {
  console.error(`\nerror: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
