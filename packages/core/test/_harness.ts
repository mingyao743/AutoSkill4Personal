/** 极简测试断言（与既有 smoke-* 同风格，不引 vitest/jest） */
let pass = 0;
let fail = 0;
const failures: string[] = [];

export function ok(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    pass += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } else {
    fail += 1;
    const msg = detail ? `${name} —— ${detail}` : name;
    failures.push(msg);
    process.stdout.write(`  FAIL ${msg}\n`);
  }
}

export function eq<T>(actual: T, expected: T, name: string): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, name, same ? undefined : `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`);
}

export function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

export function summary(): number {
  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  if (fail > 0) {
    process.stdout.write(`失败项：\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
    return 1;
  }
  return 0;
}
