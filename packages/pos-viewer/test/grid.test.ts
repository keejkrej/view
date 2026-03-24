import { describe, expect, test } from "bun:test";
import {
  autoContrast,
  createDefaultGrid,
  estimateGridDraw,
  getFrameContrastDomain,
  gridBasis,
  normalizeGridState,
} from "../src/utils";

describe("grid utils", () => {
  test("normalizes grid inputs", () => {
    const grid = normalizeGridState({ spacingA: -1, opacity: 10, enabled: true });
    expect(grid.enabled).toBe(true);
    expect(grid.spacingA).toBe(1);
    expect(grid.opacity).toBe(1);
  });

  test("returns square basis at right angle", () => {
    const basis = gridBasis("square", 0, 10, 20);
    expect(basis.a.x).toBeCloseTo(10);
    expect(basis.a.y).toBeCloseTo(0);
    expect(basis.b.x).toBeCloseTo(0, 6);
    expect(basis.b.y).toBeCloseTo(20, 6);
  });

  test("caps dense grid previews", () => {
    const stats = estimateGridDraw(4096, 4096, 8, 8, 8000);
    expect(stats.estimated).toBeGreaterThan(8000);
    expect(stats.stride).toBeGreaterThan(1);
    expect(stats.capped).toBe(true);
  });

  test("finds useful contrast window", () => {
    const values = new Uint16Array([0, 0, 5, 10, 15, 20, 30, 40, 1000, 65535]);
    const contrast = autoContrast(values);
    expect(contrast.min).toBeGreaterThanOrEqual(0);
    expect(contrast.max).toBeGreaterThan(contrast.min);
  });

  test("uses full integer domain for contrast sliders", () => {
    expect(
      getFrameContrastDomain({
        width: 1,
        height: 1,
        pixels: new Uint16Array([42]),
      }),
    ).toEqual({ min: 0, max: 65535 });

    expect(
      getFrameContrastDomain({
        width: 1,
        height: 1,
        pixels: new Int16Array([-1]),
      }),
    ).toEqual({ min: -32768, max: 32767 });
  });

  test("default grid stays stable", () => {
    const grid = createDefaultGrid();
    expect(grid.shape).toBe("square");
    expect(grid.cellWidth).toBeGreaterThan(0);
  });
});
