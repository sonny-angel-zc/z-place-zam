import test from "node:test";
import assert from "node:assert/strict";
import { BOARD_WIDTH } from "../lib/constants.ts";
import { HttpError, parsePlacePixelInput, pixelIndex, sanitizeAgentName } from "../lib/validation.ts";

test("sanitizeAgentName trims, strips invalid chars, and collapses whitespace", () => {
  assert.equal(sanitizeAgentName("  bot<>   name!! "), "bot name");
});

test("parsePlacePixelInput accepts valid payloads", () => {
  const input = parsePlacePixelInput({
    x: 12,
    y: 34,
    color: "#000000",
    agentName: "agent-1"
  });

  assert.deepEqual(input, {
    x: 12,
    y: 34,
    color: "#000000",
    agentName: "agent-1"
  });
});

test("parsePlacePixelInput rejects out of bounds coordinates", () => {
  assert.throws(
    () =>
      parsePlacePixelInput({
        x: BOARD_WIDTH,
        y: 0,
        color: "#000000",
        agentName: "agent-1"
      }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("pixelIndex creates row-major indexes", () => {
  assert.equal(pixelIndex(0, 0), 0);
  assert.equal(pixelIndex(5, 2), 2005);
});
