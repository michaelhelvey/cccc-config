// Configuration guide: https://rstack.rs/config
// Rstack is used for linting, formatting, and git hooks only. Bun runs,
// tests, and resolves all TypeScript directly -- there is no build step.
import { define } from "rstack";

define.lint(({ js, ts }) => [
  js.configs.recommended,
  ts.configs.recommendedTypeChecked,
  { rules: { "func-style": ["error", "declaration"] } },
  {
    languageOptions: {
      parserOptions: { project: ["./tsconfig.json"] },
    },
  },
]);

define.fmt({
  singleQuote: false,
  proseWrap: "always",
  printWidth: 100,
});

define.staged({
  "*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}": ["rs lint --fix", "rs fmt"],
  "*.{json,jsonc,md,mdx,css,html,yml,yaml}": "rs fmt",
});
