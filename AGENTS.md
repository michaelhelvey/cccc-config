## Toolchains

- Use rstack cli for linting and formatting (node_modules/rstack/docs/llms.txt)
- Use bun for package management and runtime code, including unit tests (https://bun.sh/llms.txt)

## General Rules

- Always validate your work via all relevant checks (`bun run validate`) before declaring your work
  done.
- Keep relevant documentation up-to-date when you change code. This does _not_ mean you must _add_
  documentation for every change, it just means that if there is existing documentation affected by
  your change, then you should update it.

## Typescript Rules

- All documentation and code comments should use ASD-STE100 Simplified Technical English.
- Add doc comments to all public exports from a module. Avoid non-doc comments within code unless
  overwhelmingly necessary to explain an otherwise odd decision that would strike the reader as
  wrong at first glance (e.g. a lint ignore).
- Always use `zod` to parse unknown types, rather than casting.

## Testing Rules

- Do not write tautological tests. Tests must assert something meaningful about the system that they
  test which cannot be trivially derived from the literal tokens in the code.
- Do not write code that requires module mocks in order to test -- use proper dependency injection.
  Creating `mock` functions from `bun:test` in order to assert how they are called is allowed.

## Github / Collaboration Rules

- Don't make git commits unless you're in a worktree or I ask you to. If you're not in a worktree,
  that means that you are working collaboratively with me and other agents.
- Outside of a worktree, other agents and humans will be working with you in the same working tree.
  Do not change unrelated files or step on their work.
