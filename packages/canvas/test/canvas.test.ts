import { describe, expect, test } from "bun:test";

import { ViewerCanvasSurface } from "../src";

describe("canvas package", () => {
  test("exports the canvas surface", () => {
    expect(typeof ViewerCanvasSurface).toBe("function");
  });
});
