import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigArray } from "./config-array.ts";
import { convertIgnorePattern, includeIgnoreFile } from "./ignore-file.ts";

describe("convertIgnorePattern", () => {
  test.each([
    ["dist", "**/dist"],
    ["dist/", "**/dist/"],
    ["/dist", "dist"],
    ["src/gen", "src/gen"],
    ["!keep.ts", "!**/keep.ts"],
    ["vendor/**", "vendor/**/*"],
    ["*.log", "**/*.log"],
    ["file(1).ts", "**/file\\(1).ts"],
  ])("converts %p to %p", (input, expected) => {
    expect(convertIgnorePattern(input)).toBe(expected);
  });
});

describe("includeIgnoreFile", () => {
  test("gitignore rules apply as global ignores at all depths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cccc-ignore-"));
    const path = join(dir, ".gitignore");
    await writeFile(path, "# build output\ndist/\n/coverage\n*.gen.ts\n\n");

    const configs = new ConfigArray([includeIgnoreFile(path)], ["**/*.ts"]);

    expect(configs.isFileIgnored("packages/a/dist/index.ts")).toBe(true);
    expect(configs.isFileIgnored("coverage/x.ts")).toBe(true);
    expect(configs.isFileIgnored("src/coverage/x.ts")).toBe(false);
    expect(configs.isFileIgnored("src/api.gen.ts")).toBe(true);
    expect(configs.isFileIgnored("src/api.ts")).toBe(false);
  });
});
