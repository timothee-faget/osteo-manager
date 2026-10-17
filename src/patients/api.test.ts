import { ageOn } from "./api";

test("âge en années révolues", () => {
  const today = new Date(2026, 9, 17); // 17/10/2026
  expect(ageOn("1984-05-12", today)).toBe(42);
  expect(ageOn("1984-10-17", today)).toBe(42);
  expect(ageOn("1984-10-18", today)).toBe(41);
  expect(ageOn("2026-01-01", today)).toBe(0);
});
