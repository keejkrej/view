import { describe, expect, test } from "bun:test";

import {
  RoiAnnotationCanvas,
  RoiAnnotationEditor,
  createEmptyMask,
  decodeMaskBase64Png,
  encodeMaskToBase64Png,
} from "../src";

describe("annotate package", () => {
  test("exports the annotation surface", () => {
    expect(typeof RoiAnnotationCanvas).toBe("function");
    expect(typeof RoiAnnotationEditor).toBe("function");
  });

  test("creates empty masks with the expected size", () => {
    const mask = createEmptyMask(8, 4);
    expect(mask).toBeInstanceOf(Uint8Array);
    expect(mask.length).toBe(32);
    expect(mask.every((value) => value === 0)).toBe(true);
  });

  test("exports mask PNG helpers", () => {
    expect(typeof decodeMaskBase64Png).toBe("function");
    expect(typeof encodeMaskToBase64Png).toBe("function");
  });
});
