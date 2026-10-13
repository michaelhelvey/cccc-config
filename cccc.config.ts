import { defineConfig } from "./src/index.ts";

export default defineConfig(
  { name: "global ignores", ignores: ["native/target/"] },
  {
    name: "defaults",
    rules: {
      "cognitive-complexity": ["error", 15],
      "cyclomatic-complexity": ["warn", 15],
    },
  },
  {
    name: "tests",
    files: ["**/*.test.ts"],
    rules: { "cognitive-complexity": "warn" },
  },
);
