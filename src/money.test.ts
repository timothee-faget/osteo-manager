import {
  bpToInput,
  formatEuros,
  formatPercent,
  parseEuros,
  parsePercent,
} from "./money";

test("parse les montants saisis en euros", () => {
  expect(parseEuros("60")).toBe(6000);
  expect(parseEuros("60,5")).toBe(6050);
  expect(parseEuros("60.55")).toBe(6055);
  expect(parseEuros(" 1 234,56 ")).toBe(123456);
  // Narrow no-break space, as produced by toLocaleString("fr-FR").
  expect(parseEuros("1\u202f234,56")).toBe(123456);
  expect(parseEuros("0,07")).toBe(7);
  for (const bad of ["", "abc", "60,555", "-5", "6O", "1,2,3"]) {
    expect(parseEuros(bad)).toBeNull();
  }
});

test("formate les centimes", () => {
  expect(formatEuros(6000)).toBe("60,00 €");
  expect(formatEuros(7)).toBe("0,07 €");
  expect(formatEuros(-1250)).toBe("-12,50 €");
});

test("taux en points de base", () => {
  expect(parsePercent("45")).toBe(4500);
  expect(parsePercent("26,5")).toBe(2650);
  expect(parsePercent("0")).toBe(0);
  expect(bpToInput(4500)).toBe("45");
  expect(bpToInput(2650)).toBe("26,5");
  expect(formatPercent(3000)).toBe("30 %");
  expect(formatPercent(1)).toBe("0,01 %");
});
