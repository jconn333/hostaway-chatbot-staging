import test from "node:test";
import assert from "node:assert/strict";
import { findListingIdFromMessage } from "../src/lib/listings.js";

test("findListingIdFromMessage matches numbered treehouse without hash", () => {
  const listings = [
    { id: 11, name: "Treehouse #3" },
    { id: 12, name: "Treehouse #7" },
    { id: 13, name: "Lofty Willows Treehouse" },
  ];
  const id = findListingIdFromMessage("Is Treehouse 3 available this weekend?", listings);
  assert.equal(id, 11);
});

test("findListingIdFromMessage keeps numeric disambiguation", () => {
  const listings = [
    { id: 21, name: "Premier Cottage #3" },
    { id: 22, name: "Premier Cottage #10" },
  ];
  const id = findListingIdFromMessage("Tell me about premier cottage 10", listings);
  assert.equal(id, 22);
});
