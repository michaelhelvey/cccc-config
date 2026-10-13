import { stripVTControlCharacters, styleText } from "node:util";
import { flattenFunctions, type AnalysisResult, type MetricSummary } from "./analyze.ts";

/** The names of the output formats. */
export const FORMATS = ["stylish", "json", "table"] as const;

/** The name of an output format. */
export type Format = (typeof FORMATS)[number];

/** Options for the formatters. */
export interface FormatOptions {
  /** Use ANSI colors. */
  color: boolean;
  /** Show only problems with severity `"error"` (stylish format). */
  quiet?: boolean;
  /** The number of rows in the table format. */
  top?: number;
}

type Style = Parameters<typeof styleText>[0];

/** Formats an analysis result as text. */
export function format(result: AnalysisResult, name: Format, options: FormatOptions): string {
  switch (name) {
    case "json":
      return `${JSON.stringify(result, null, 2)}\n`;
    case "table":
      return formatTable(result, options);
    case "stylish":
      return formatStylish(result, options);
  }
}

/**
 * Formats problems grouped by file, in the style of the ESLint `stylish`
 * formatter. Returns an empty string when there are no problems.
 */
export function formatStylish(result: AnalysisResult, options: FormatOptions): string {
  const paint = painter(options.color);
  const lines: string[] = [];
  let errors = 0;
  let warnings = 0;

  for (const file of result.files) {
    const problems = file.problems.filter((p) => !options.quiet || p.severity === "error");
    if (problems.length === 0) {
      continue;
    }
    const rows = problems.map((p) => [
      String(p.line ?? 0),
      p.severity === "error" ? paint("red", "error") : paint("yellow", "warning"),
      p.message,
      paint("dim", p.ruleId ?? ""),
    ]);
    const widths = [0, 1].map((col) =>
      Math.max(...rows.map((row) => visibleLength(row[col] ?? ""))),
    );
    lines.push(paint("underline", file.relativePath));
    for (const [line = "", severity = "", message = "", rule = ""] of rows) {
      lines.push(
        `  ${paint("dim", line.padStart(widths[0] ?? 0))}  ${pad(severity, widths[1] ?? 0)}  ${message}  ${rule}`.trimEnd(),
      );
    }
    lines.push("");
    errors += problems.filter((p) => p.severity === "error").length;
    warnings += problems.filter((p) => p.severity === "warn").length;
  }

  const total = errors + warnings;
  if (total === 0) {
    return "";
  }
  const summary = `✖ ${plural(total, "problem")} (${plural(errors, "error")}, ${plural(warnings, "warning")})`;
  lines.push(paint(["bold", errors > 0 ? "red" : "yellow"], summary), "");
  return lines.join("\n");
}

/**
 * Formats a ranking of the most complex functions, ordered by cognitive
 * complexity, and a summary of the distribution of each metric.
 */
export function formatTable(result: AnalysisResult, options: FormatOptions): string {
  const paint = painter(options.color);
  const ranked = result.files
    .flatMap((file) =>
      flattenFunctions(file.report?.functions ?? []).map((fn) => ({ file: file.relativePath, fn })),
    )
    .sort(
      (a, b) =>
        b.fn.cognitive - a.fn.cognitive ||
        b.fn.cyclomatic - a.fn.cyclomatic ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : a.fn.line - b.fn.line),
    )
    .slice(0, options.top ?? 20);

  const header = ["cognitive", "cyclomatic", "function", "location"];
  const rows = ranked.map(({ file, fn }) => [
    String(fn.cognitive),
    String(fn.cyclomatic),
    `${fn.name} ${paint("dim", `(${fn.kind})`)}`,
    `${file}:${fn.line}`,
  ]);
  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((row) => visibleLength(row[col] ?? ""))),
  );
  function render(row: string[]): string {
    return row
      .map((cell, col) =>
        col < 2 ? padStart(cell, widths[col] ?? 0) : pad(cell, widths[col] ?? 0),
      )
      .join("  ")
      .trimEnd();
  }

  const { summary } = result;
  function metric(label: string, m: MetricSummary): string {
    return `${label.padEnd(10)}  sum ${m.sum}  max ${m.max}  median ${m.median}  p90 ${m.p90}  p95 ${m.p95}`;
  }

  return [
    paint("bold", render(header)),
    ...rows.map(render),
    "",
    paint(
      "dim",
      `${plural(summary.functionCount, "function")} in ${plural(summary.fileCount, "file")}`,
    ),
    metric("cognitive", summary.cognitive),
    metric("cyclomatic", summary.cyclomatic),
    ...problemLine(result, paint),
    "",
  ].join("\n");
}

function problemLine(result: AnalysisResult, paint: ReturnType<typeof painter>): string[] {
  const { errorCount, warningCount } = result;
  if (errorCount + warningCount === 0) {
    return [];
  }
  const counts = `${plural(errorCount, "error")}, ${plural(warningCount, "warning")}`;
  return [
    "",
    paint(
      ["bold", errorCount > 0 ? "red" : "yellow"],
      `✖ ${plural(errorCount + warningCount, "problem")} (${counts}). Use the stylish format to see them.`,
    ),
  ];
}

function painter(color: boolean) {
  return (style: Style, text: string) =>
    color && text !== "" ? styleText(style, text, { validateStream: false }) : text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function visibleLength(text: string): number {
  return stripVTControlCharacters(text).length;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleLength(text))) + text;
}
