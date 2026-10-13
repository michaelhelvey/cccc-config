#!/usr/bin/env bun
import { runCli } from "../src/cli.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  isTTY: process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined,
});
