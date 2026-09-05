export type FormulaToken =
  | { kind: "number"; value: number }
  | { kind: "stat"; id: string }
  | { kind: "operator"; value: "+" | "-" | "*" | "/" };

const PRECEDENCE = { "+": 1, "-": 1, "*": 2, "/": 2 } as const;
type FormulaOperator = keyof typeof PRECEDENCE;

export function validateDiceExpression(source: string): { valid: boolean; minimum?: number; maximum?: number; error?: string } {
  const match = source.trim().match(/^(\d{1,3})d(\d{1,6})(?:\s*([+-])\s*(\d{1,9}))?$/i);
  if (!match) return { valid: false, error: "NdM 또는 NdM+K 형식으로 입력하세요." };
  const count = Number(match[1]);
  const sides = Number(match[2]);
  const offset = match[4] ? Number(match[4]) * (match[3] === "-" ? -1 : 1) : 0;
  if (count < 1 || sides < 2) return { valid: false, error: "주사위 개수는 1 이상, 면 수는 2 이상이어야 합니다." };
  return { valid: true, minimum: count + offset, maximum: count * sides + offset };
}

export function parseFormula(source: string, knownStats: Set<string>): { tokens: FormulaToken[]; dependencies: string[] } {
  const parts = source.match(/[A-Za-z_][A-Za-z0-9_-]*|\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
  if (parts.join("") !== source.replace(/\s+/g, "")) throw new Error("지원하지 않는 수식 문자가 있습니다.");
  const output: FormulaToken[] = [];
  const operators: string[] = [];
  const dependencies = new Set<string>();
  for (const part of parts) {
    if (/^\d/.test(part)) output.push({ kind: "number", value: Number(part) });
    else if (/^[A-Za-z_]/.test(part)) {
      if (!knownStats.has(part)) throw new Error(`알 수 없는 수치: ${part}`);
      dependencies.add(part);
      output.push({ kind: "stat", id: part });
    } else if (part === "(") operators.push(part);
    else if (part === ")") {
      while (operators.length && operators[operators.length - 1] !== "(") output.push({ kind: "operator", value: operators.pop() as FormulaOperator });
      if (operators.pop() !== "(") throw new Error("괄호가 맞지 않습니다.");
    } else {
      const operator = part as FormulaOperator;
      while (operators.length && operators[operators.length - 1] !== "(" && PRECEDENCE[operators[operators.length - 1] as FormulaOperator] >= PRECEDENCE[operator]) {
        output.push({ kind: "operator", value: operators.pop() as FormulaOperator });
      }
      operators.push(operator);
    }
  }
  while (operators.length) {
    const operator = operators.pop()!;
    if (operator === "(") throw new Error("괄호가 맞지 않습니다.");
    output.push({ kind: "operator", value: operator as "+" | "-" | "*" | "/" });
  }
  return { tokens: output, dependencies: [...dependencies] };
}

export function evaluateFormula(tokens: FormulaToken[], values: Record<string, number>): number {
  const stack: number[] = [];
  for (const token of tokens) {
    if (token.kind === "number") stack.push(token.value);
    else if (token.kind === "stat") stack.push(values[token.id] ?? 0);
    else {
      const right = stack.pop(); const left = stack.pop();
      if (left === undefined || right === undefined) throw new Error("완전하지 않은 수식입니다.");
      if (token.value === "+") stack.push(left + right);
      else if (token.value === "-") stack.push(left - right);
      else if (token.value === "*") stack.push(left * right);
      else {
        if (right === 0) throw new Error("0으로 나눌 수 없습니다.");
        stack.push(left / right);
      }
    }
  }
  if (stack.length !== 1 || !Number.isFinite(stack[0])) throw new Error("수식을 계산할 수 없습니다.");
  return stack[0];
}
