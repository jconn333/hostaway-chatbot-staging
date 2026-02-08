import test from "node:test";
import assert from "node:assert/strict";
import { getCanonicalAmenity, hasAmenity } from "../src/lib/inventory.js";

test("getCanonicalAmenity normalizes plural and synonym inputs", () => {
  assert.equal(getCanonicalAmenity("hot tubs"), "hot tub");
  assert.equal(getCanonicalAmenity("hottubs"), "hot tub");
  assert.equal(getCanonicalAmenity("spa"), "hot tub");
  assert.equal(getCanonicalAmenity("POOLS"), "pool");
});

test("hasAmenity matches canonicalized keys against listing amenity text", () => {
  const safe = {
    amenities: ["Private Hot Tub", "Fireplace"],
  };
  assert.equal(hasAmenity(safe, "hot tubs"), true);
  assert.equal(hasAmenity(safe, "spa"), true);
  assert.equal(hasAmenity(safe, "pool"), false);
});
