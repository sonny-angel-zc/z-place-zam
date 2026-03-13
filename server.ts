import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_COLORS,
  BOARD_HEIGHT,
  BOARD_WIDTH
} from "./lib/constants.js";
import { getBoardState, placePixel } from "./lib/storage.js";
import type { AllowedColor } from "./lib/constants.js";
import type { BoardStateResponse } from "./lib/types.js";
import { HttpError, parsePlacePixelInput } from "./lib/validation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

const SERVICE_TITLE = "Z/place Pixel Board";
const SERVICE_DESCRIPTION =
  "Place one pixel on a shared 1000x1000 board or call getState to fetch the current board state.";
const SERVICE_CATEGORY = "data";
const SERVICE_TAGS = ["pixels", "board", "canvas", "automation"];

type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseRunAction(payload: unknown): "placePixel" | "getState" {
  if (!payload || typeof payload !== "object") {
    return "placePixel";
  }

  const maybePayload = payload as { action?: unknown };
  if (typeof maybePayload.action !== "string") {
    return "placePixel";
  }

  if (maybePayload.action === "placePixel" || maybePayload.action === "getState") {
    return maybePayload.action;
  }

  throw new HttpError(400, "action must be 'placePixel' or 'getState'.");
}

function parseRegion(query: Record<string, unknown>): Region | null {
  const values = [query.x, query.y, query.width, query.height];
  if (values.every((value) => value === undefined)) {
    return null;
  }

  const parsed = values.map((value) => Number(value));
  if (!parsed.every((value) => Number.isInteger(value))) {
    throw new HttpError(400, "x, y, width, and height must be integers.");
  }

  const [x, y, width, height] = parsed;
  if (width <= 0 || height <= 0) {
    throw new HttpError(400, "width and height must be positive.");
  }

  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) {
    throw new HttpError(400, "x and y must be within the board.");
  }

  return {
    x,
    y,
    width: Math.min(width, BOARD_WIDTH - x),
    height: Math.min(height, BOARD_HEIGHT - y)
  };
}

function filterRegion(state: BoardStateResponse, region: Region | null): BoardStateResponse {
  if (!region) {
    return state;
  }

  const maxX = region.x + region.width - 1;
  const maxY = region.y + region.height - 1;
  const pixels = state.pixels.filter(([index]) => {
    const x = index % state.width;
    const y = Math.floor(index / state.width);
    return x >= region.x && x <= maxX && y >= region.y && y <= maxY;
  });

  return {
    ...state,
    pixels,
    region,
    isPartial: true
  };
}

function toSummary(state: BoardStateResponse): BoardStateResponse {
  return {
    ...state,
    pixels: []
  };
}

function serviceContract(origin: string) {
  return {
    listing: {
      title: SERVICE_TITLE,
      description: SERVICE_DESCRIPTION,
      category: SERVICE_CATEGORY,
      tags: SERVICE_TAGS,
      price: {
        currency: "USD",
        amountCents: 0,
        unit: "call"
      },
      runContract: {
        method: "POST",
        endpointPath: `${origin}/run`,
        inputSchema: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["x", "y", "color", "agentName"],
              properties: {
                action: { type: "string", enum: ["placePixel"] },
                x: { type: "integer", minimum: 0, maximum: BOARD_WIDTH - 1 },
                y: { type: "integer", minimum: 0, maximum: BOARD_HEIGHT - 1 },
                color: { type: "string", enum: ALLOWED_COLORS },
                agentName: { type: "string", minLength: 1, maxLength: 64 }
              }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["action"],
              properties: {
                action: { type: "string", enum: ["getState"] }
              }
            }
          ]
        },
        outputSchema: {
          oneOf: [
            {
              type: "object",
              required: ["ok", "pixel", "nextAvailableAt", "state"],
              properties: {
                ok: { type: "boolean" },
                pixel: {
                  type: "object",
                  required: ["x", "y", "index", "color"],
                  properties: {
                    x: { type: "integer" },
                    y: { type: "integer" },
                    index: { type: "integer" },
                    color: { type: "string", enum: ALLOWED_COLORS }
                  }
                },
                nextAvailableAt: { type: "string", format: "date-time" },
                state: {
                  type: "object",
                  required: ["pixelCount", "updatedAt"],
                  properties: {
                    pixelCount: { type: "integer" },
                    updatedAt: { type: "string", format: "date-time" }
                  }
                }
              }
            },
            {
              type: "object",
              required: ["ok", "action", "state", "stateUrl", "imageUrl"],
              properties: {
                ok: { type: "boolean" },
                action: { type: "string", enum: ["getState"] },
                state: { type: "object" },
                stateUrl: { type: "string", format: "uri" },
                imageUrl: { type: "string", format: "uri" }
              }
            }
          ]
        }
      }
    }
  };
}

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use((_, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options(/.*/, (_request, response) => {
  response.status(204).end();
});

app.get("/info", (_request, response) => {
  response.json({
    name: SERVICE_TITLE,
    description: SERVICE_DESCRIPTION
  });
});

app.get("/contract", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(serviceContract(`${request.protocol}://${request.get("host")}`));
});

app.get("/api/summary", async (_request, response, next) => {
  try {
    const state = await getBoardState();
    response.setHeader("Cache-Control", "no-store");
    response.json(toSummary(state));
  } catch (error) {
    next(error);
  }
});

app.get("/api/state", async (request, response, next) => {
  try {
    const state = await getBoardState();
    const region = parseRegion(request.query);
    response.setHeader("Cache-Control", "no-store");
    response.json(region ? filterRegion(state, region) : state);
  } catch (error) {
    next(error);
  }
});

app.get("/api/image", async (_request, response, next) => {
  try {
    const state = await getBoardState();
    const rects = state.pixels
      .map(([index, color]) => {
        const x = index % BOARD_WIDTH;
        const y = Math.floor(index / BOARD_WIDTH);
        return `<rect x="${x}" y="${y}" width="1" height="1" fill="${escapeXml(color)}" />`;
      })
      .join("");

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}" shape-rendering="crispEdges">` +
      `<rect width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" fill="#ffffff"/>${rects}</svg>`;

    response.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.send(svg);
  } catch (error) {
    next(error);
  }
});

app.post("/api/place", async (request, response, next) => {
  try {
    const input = parsePlacePixelInput(request.body);
    const result = await placePixel(input);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/run", async (request, response, next) => {
  try {
    const action = parseRunAction(request.body ?? {});
    const origin = `${request.protocol}://${request.get("host")}`;
    if (action === "getState") {
      const state = await getBoardState();
      response.json({
        ok: true,
        action: "getState",
        state: toSummary(state),
        stateUrl: `${origin}/api/state`,
        imageUrl: `${origin}/api/image`
      });
      return;
    }

    const input = parsePlacePixelInput(request.body);
    const result = await placePixel(input);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(publicDir));

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof HttpError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Internal server error.";
  response.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`z-place-zam listening on :${port}`);
});
