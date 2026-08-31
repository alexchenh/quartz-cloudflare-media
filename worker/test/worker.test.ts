import { describe, expect, it } from "vitest";
import { validObjectKey } from "../src/keys";

describe("object-key validation", () => {
  it("accepts content-addressed keys", () => {
    expect(validObjectKey(`v1/${"a".repeat(64)}/photo.jpg`)).toBe(true);
  });

  it("rejects traversal and unhashed keys", () => {
    expect(validObjectKey(`v1/${"a".repeat(64)}/../secret.jpg`)).toBe(false);
    expect(validObjectKey("v1/photo.jpg")).toBe(false);
  });
});
