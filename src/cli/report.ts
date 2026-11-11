export type CaseResult = {
  name: string;
  ok: boolean;
  status?: number;
  durationMs?: number;
  failure?: string;
};

/** One flow (or one request run on its own): a JUnit testsuite whose testcases are its steps. */
export type SuiteResult = {
  name: string;
  file: string;
  durationMs: number;
  cases: CaseResult[];
  /** The flow could not run at all (unknown flow, invalid definition…). */
  error?: string;
};

export type RunReport = {
  startedAt: string;
  suites: SuiteResult[];
  skipped: Array<{ file: string; reason: string }>;
};

const xml = (s: string) =>
  s
    // Characters XML 1.0 does not allow at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const seconds = (ms: number | undefined) => ((ms ?? 0) / 1000).toFixed(3);

export function totals(report: RunReport) {
  let tests = 0;
  let failures = 0;
  let errors = 0;
  for (const s of report.suites) {
    if (s.error !== undefined) {
      errors += 1;
      tests += 1;
    }
    tests += s.cases.length;
    failures += s.cases.filter((c) => !c.ok).length;
  }
  return { tests, failures, errors };
}

/** JUnit XML, the format GitHub Actions, GitLab, Jenkins and Azure DevOps read. */
export function renderJunit(report: RunReport): string {
  const t = totals(report);
  const time = report.suites.reduce((n, s) => n + s.durationMs, 0);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="conversational-api-test-mcp" tests="${t.tests}" failures="${t.failures}" errors="${t.errors}" time="${seconds(time)}">`,
  ];
  for (const s of report.suites) {
    const failures = s.cases.filter((c) => !c.ok).length;
    const tests = s.cases.length + (s.error !== undefined ? 1 : 0);
    lines.push(
      `  <testsuite name="${xml(s.name)}" file="${xml(s.file)}" tests="${tests}" failures="${failures}" errors="${s.error !== undefined ? 1 : 0}" time="${seconds(s.durationMs)}" timestamp="${report.startedAt}">`,
    );
    if (s.error !== undefined) {
      lines.push(
        `    <testcase name="${xml(s.name)}" classname="${xml(s.file)}" time="0.000">`,
        `      <error message="${xml(s.error)}"/>`,
        "    </testcase>",
      );
    }
    for (const c of s.cases) {
      const open = `    <testcase name="${xml(c.name)}" classname="${xml(s.name)}" time="${seconds(c.durationMs)}"`;
      if (c.ok) {
        lines.push(`${open}/>`);
      } else {
        const msg = c.failure ?? "failed";
        lines.push(
          `${open}>`,
          `      <failure message="${xml(msg.split("\n")[0].slice(0, 300))}">${xml(
            c.status !== undefined ? `status ${c.status}\n${msg}` : msg,
          )}</failure>`,
          "    </testcase>",
        );
      }
    }
    lines.push("  </testsuite>");
  }
  lines.push("</testsuites>", "");
  return lines.join("\n");
}

export function renderPretty(report: RunReport, opts: { summaryOnly?: boolean } = {}): string {
  const out: string[] = [];
  if (!opts.summaryOnly) {
    for (const s of report.suites) {
      const bad = s.error !== undefined || s.cases.some((c) => !c.ok);
      out.push(`${bad ? "✗" : "✓"} ${s.name}  (${s.durationMs}ms)`);
      if (s.error !== undefined) {
        out.push(`    error: ${s.error}`);
      }
      for (const c of s.cases) {
        const status = c.status !== undefined ? ` ${c.status}` : "";
        const time = c.durationMs !== undefined ? ` ${c.durationMs}ms` : "";
        out.push(`    ${c.ok ? "✓" : "✗"} ${c.name}${status}${time}`);
        if (!c.ok && c.failure) {
          out.push(`        ${c.failure.replace(/\n/g, "\n        ")}`);
        }
      }
    }
    for (const s of report.skipped) {
      out.push(`- skipped ${s.file}: ${s.reason}`);
    }
  }
  const t = totals(report);
  const passed = t.tests - t.failures - t.errors;
  out.push(
    `${passed} passed, ${t.failures} failed${t.errors ? `, ${t.errors} errored` : ""} (${report.suites.length} flows)`,
    "",
  );
  return out.join("\n");
}
