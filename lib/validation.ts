import {
  ALLOWED_COLOR_SET,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_AGENT_NAME_LENGTH
} from "./constants.js";
import type { AllowedColor } from "./constants.js";
import type { PlacePixelInput } from "./types.js";

const AGENT_NAME_PATTERN = /[^a-zA-Z0-9 _.-]/g;

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function sanitizeAgentName(input: string): string {
  const cleaned = input.trim().replace(AGENT_NAME_PATTERN, "");
  return cleaned.replace(/\s+/g, " ").slice(0, MAX_AGENT_NAME_LENGTH);
}

export function parsePlacePixelInput(payload: unknown): {
  x: number;
  y: number;
  color: AllowedColor;
  agentName: string;
} {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "Body must be a JSON object.");
  }

  const { x, y, color, agentName } = payload as Partial<PlacePixelInput>;

  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new HttpError(400, "x and y must be integers.");
  }

  const xNum = x as number;
  const yNum = y as number;

  if (xNum < 0 || xNum >= BOARD_WIDTH || yNum < 0 || yNum >= BOARD_HEIGHT) {
    throw new HttpError(400, "x and y must be within the 1000x1000 canvas.");
  }

  if (typeof color !== "string" || !ALLOWED_COLOR_SET.has(color)) {
    throw new HttpError(400, "color must be one of the allowed palette values.");
  }

  if (typeof agentName !== "string") {
    throw new HttpError(400, "agentName is required.");
  }

  const sanitizedAgentName = sanitizeAgentName(agentName);
  if (!sanitizedAgentName) {
    throw new HttpError(400, "agentName must contain at least one valid character.");
  }

  return {
    x: xNum,
    y: yNum,
    color: color as AllowedColor,
    agentName: sanitizedAgentName
  };
}

export function pixelIndex(x: number, y: number): number {
  return y * BOARD_WIDTH + x;
}
