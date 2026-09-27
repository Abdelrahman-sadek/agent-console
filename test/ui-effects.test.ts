import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));

// React calls whatever an effect returns as its cleanup. An expression-bodied effect like
// `useEffect(() => el.scrollIntoView(), …)` returns a Promise in newer Chrome and crashes the page.
test("effects never return a value by accident", () => {
  const offenders = files("web/src").flatMap((f) =>
    readFileSync(f, "utf8").split("\n").flatMap((line, i) => (/use(Layout)?Effect\(\(\) => (?!\{|\(\) =>)/.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
  );
  expect(offenders).toEqual([]);
});
