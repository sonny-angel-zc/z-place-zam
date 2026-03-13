import {
  ALLOWED_COLORS,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  COOLDOWN_SECONDS,
  RECENT_AGENT_LIMIT,
  STATE_VERSION
} from "../lib/constants.js";
import type { AllowedColor } from "../lib/constants.js";
import type {
  BoardStateResponse,
  BoardBounds,
  PlacementRecord,
  PlacePixelResponse
} from "../lib/types.js";
import { HttpError, parsePlacePixelInput, pixelIndex } from "../lib/validation.js";

type BoardMeta = {
  pixelCount: number;
  updatedAt: string | null;
  bounds: BoardBounds | null;
};

type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Env = {
  ASSETS?: Fetcher;
  BOARD: DurableObjectNamespace;
  ZPLACE_BOARD_NAME?: string;
};

type PersistedData = {
  pixels: Map<number, AllowedColor>;
  meta: BoardMeta;
  recentAgents: PlacementRecord[];
};

const STORAGE_KEYS = {
  meta: "meta",
  recentAgents: "recentAgents"
} as const;

const STORAGE_PREFIX = {
  pixel: "pixel:",
  cooldown: "cooldown:"
} as const;

const SERVICE_TITLE = "Z/place Pixel Board";
const SERVICE_DESCRIPTION =
  "Place one pixel on a shared 1000x1000 board or call getState to fetch the current board state.";
const SERVICE_CATEGORY = "data";
const SERVICE_TAGS = ["pixels", "board", "canvas", "automation"];
const SERVICE_PRICE_CURRENCY = "USD";
const SERVICE_PRICE_AMOUNT_CENTS = 0;
const SERVICE_PRICE_UNIT = "call";

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(body, {
    ...init,
    headers
  });
}

function toBoardState(data: PersistedData): BoardStateResponse {
  return toBoardStateWithPixels(data.meta, data.recentAgents, [...data.pixels.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, color]) => [index, color] as [number, AllowedColor]));
}

function toBoardStateWithPixels(
  meta: BoardMeta,
  recentAgents: PlacementRecord[],
  pixels: [number, AllowedColor][],
  region?: Region
): BoardStateResponse {
  return {
    width: BOARD_WIDTH,
    height: BOARD_HEIGHT,
    cooldownSeconds: COOLDOWN_SECONDS,
    palette: ALLOWED_COLORS,
    pixelCount: meta.pixelCount,
    updatedAt: meta.updatedAt,
    bounds: meta.bounds,
    recentAgents: recentAgents.slice(0, RECENT_AGENT_LIMIT),
    pixels,
    version: STATE_VERSION,
    region,
    isPartial: Boolean(region)
  };
}

function emptyMeta(): BoardMeta {
  return {
    pixelCount: 0,
    updatedAt: null,
    bounds: null
  };
}

function normalizeMeta(meta: BoardMeta | null | undefined): BoardMeta {
  if (!meta) {
    return emptyMeta();
  }

  const bounds = meta.bounds;
  if (
    bounds &&
    Number.isInteger(bounds.minX) &&
    Number.isInteger(bounds.minY) &&
    Number.isInteger(bounds.maxX) &&
    Number.isInteger(bounds.maxY)
  ) {
    return {
      pixelCount: meta.pixelCount,
      updatedAt: meta.updatedAt,
      bounds
    };
  }

  return {
    pixelCount: meta.pixelCount,
    updatedAt: meta.updatedAt,
    bounds: null
  };
}

function computeBounds(pixels: Map<number, AllowedColor>): BoardBounds | null {
  let bounds: BoardBounds | null = null;

  for (const index of pixels.keys()) {
    const x = index % BOARD_WIDTH;
    const y = Math.floor(index / BOARD_WIDTH);
    if (!bounds) {
      bounds = { minX: x, minY: y, maxX: x, maxY: y };
      continue;
    }

    bounds = {
      minX: Math.min(bounds.minX, x),
      minY: Math.min(bounds.minY, y),
      maxX: Math.max(bounds.maxX, x),
      maxY: Math.max(bounds.maxY, y)
    };
  }

  return bounds;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serviceInfo() {
  return {
    name: SERVICE_TITLE,
    description: SERVICE_DESCRIPTION
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function parseRunAction(payload: unknown): "placePixel" | "getState" {
  if (!isRecord(payload) || typeof payload.action !== "string") {
    return "placePixel";
  }

  if (payload.action === "getState" || payload.action === "placePixel") {
    return payload.action;
  }

  throw new HttpError(400, "action must be 'placePixel' or 'getState'.");
}

function parseRegion(searchParams: URLSearchParams): Region | null {
  const values = ["x", "y", "width", "height"].map((key) => searchParams.get(key));
  if (values.every((value) => value === null)) {
    return null;
  }

  const [xValue, yValue, widthValue, heightValue] = values;
  const parsed = [xValue, yValue, widthValue, heightValue].map((value) =>
    value === null ? Number.NaN : Number(value)
  );

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

function serviceContract(origin: string) {
  return {
    listing: {
      title: SERVICE_TITLE,
      description: SERVICE_DESCRIPTION,
      category: SERVICE_CATEGORY,
      tags: SERVICE_TAGS,
      price: {
        currency: SERVICE_PRICE_CURRENCY,
        amountCents: SERVICE_PRICE_AMOUNT_CENTS,
        unit: SERVICE_PRICE_UNIT
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
        },
        requestExampleJson: JSON.stringify({
          action: "placePixel",
          x: 12,
          y: 34,
          color: "#ff4500",
          agentName: "zam-bot-1"
        }),
        responseExampleJson: JSON.stringify({
          ok: true,
          pixel: {
            x: 12,
            y: 34,
            index: 34012,
            color: "#ff4500"
          },
          nextAvailableAt: "2026-03-12T10:01:00.000Z",
          state: {
            pixelCount: 1,
            updatedAt: "2026-03-12T10:00:00.000Z"
          }
        })
      }
    }
  };
}

export class BoardDurableObject implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private metaLoaded = false;
  private recentAgentsLoaded = false;
  private pixelsLoaded = false;
  private pixels = new Map<number, AllowedColor>();
  private meta: BoardMeta = emptyMeta();
  private recentAgents: PlacementRecord[] = [];
  private cooldownCache = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      if (request.method === "GET" && url.pathname === "/internal/state") {
        const region = parseRegion(url.searchParams);
        const state = await this.getState(region);
        return json(state, {
          headers: {
            "Cache-Control": "no-store"
          }
        });
      }

      if (request.method === "GET" && url.pathname === "/internal/summary") {
        const summary = await this.getState();
        return json(summary, {
          headers: {
            "Cache-Control": "no-store"
          }
        });
      }

      if (request.method === "GET" && url.pathname === "/internal/image") {
        await this.loadPixels();
        const rects = [...this.pixels.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, color]) => {
            const x = index % BOARD_WIDTH;
            const y = Math.floor(index / BOARD_WIDTH);
            return `<rect x="${x}" y="${y}" width="1" height="1" fill="${escapeXml(color)}" />`;
          })
          .join("");

        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}" shape-rendering="crispEdges">` +
          `<rect width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" fill="#ffffff"/>${rects}</svg>`;

        return text(svg, {
          headers: {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Cache-Control": "no-store"
          }
        });
      }

      if (request.method === "POST" && url.pathname === "/internal/place") {
        const body = await request.json();
        const input = parsePlacePixelInput(body);
        const result = await this.placePixel(input);
        return json(result);
      }

      return json({ error: "Not found." }, { status: 404 });
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, { status: error.statusCode });
      }

      const message = error instanceof Error ? error.message : "Internal server error.";
      return json({ error: message }, { status: 500 });
    }
  }

  private getData(): PersistedData {
    return {
      pixels: this.pixels,
      meta: this.meta,
      recentAgents: this.recentAgents
    };
  }

  private async loadMeta(): Promise<void> {
    if (this.metaLoaded) {
      return;
    }

    const meta = await this.ctx.storage.get<BoardMeta>(STORAGE_KEYS.meta);
    this.meta = normalizeMeta(meta);
    this.metaLoaded = true;
  }

  private async loadRecentAgents(): Promise<void> {
    if (this.recentAgentsLoaded) {
      return;
    }

    const recentAgents = await this.ctx.storage.get<PlacementRecord[]>(STORAGE_KEYS.recentAgents);
    this.recentAgents = recentAgents ?? [];
    this.recentAgentsLoaded = true;
  }

  private async loadPixels(): Promise<void> {
    if (this.pixelsLoaded) {
      return;
    }

    await this.loadMeta();
    const pixelEntries = await this.ctx.storage.list<AllowedColor>({ prefix: STORAGE_PREFIX.pixel });
    this.pixels = new Map<number, AllowedColor>();

    for (const [key, color] of pixelEntries) {
      const index = Number(String(key).slice(STORAGE_PREFIX.pixel.length));
      if (Number.isInteger(index)) {
        this.pixels.set(index, color);
      }
    }

    this.meta = normalizeMeta(this.meta);
    if (!this.meta.bounds && this.pixels.size > 0) {
      this.meta = {
        ...this.meta,
        bounds: computeBounds(this.pixels)
      };
    }
    this.pixelsLoaded = true;
  }

  private async getState(region: Region | null = null): Promise<BoardStateResponse> {
    await Promise.all([this.loadMeta(), this.loadRecentAgents()]);

    if (!region) {
      return toBoardStateWithPixels(this.meta, this.recentAgents, []);
    }

    await this.loadPixels();
    const maxX = region.x + region.width - 1;
    const maxY = region.y + region.height - 1;
    const pixels = [...this.pixels.entries()]
      .filter(([index]) => {
        const x = index % BOARD_WIDTH;
        const y = Math.floor(index / BOARD_WIDTH);
        return x >= region.x && x <= maxX && y >= region.y && y <= maxY;
      })
      .sort((a, b) => a[0] - b[0])
      .map(([index, color]) => [index, color] as [number, AllowedColor]);

    return toBoardStateWithPixels(this.meta, this.recentAgents, pixels, region);
  }

  private updateBounds(x: number, y: number): void {
    if (!this.meta.bounds) {
      this.meta.bounds = { minX: x, minY: y, maxX: x, maxY: y };
      return;
    }

    this.meta.bounds = {
      minX: Math.min(this.meta.bounds.minX, x),
      minY: Math.min(this.meta.bounds.minY, y),
      maxX: Math.max(this.meta.bounds.maxX, x),
      maxY: Math.max(this.meta.bounds.maxY, y)
    };
  }

  private async getAgentCooldown(agentName: string): Promise<number> {
    const cached = this.cooldownCache.get(agentName);
    if (typeof cached === "number") {
      return cached;
    }

    const stored = await this.ctx.storage.get<number>(`${STORAGE_PREFIX.cooldown}${agentName}`);
    const value = typeof stored === "number" ? stored : 0;
    this.cooldownCache.set(agentName, value);
    return value;
  }

  private async placePixel(input: {
    x: number;
    y: number;
    color: AllowedColor;
    agentName: string;
  }): Promise<PlacePixelResponse> {
    await Promise.all([this.loadMeta(), this.loadRecentAgents()]);

    const now = Date.now();
    const cooldownMs = COOLDOWN_SECONDS * 1000;
    const lastPlacement = await this.getAgentCooldown(input.agentName);

    if (now - lastPlacement < cooldownMs) {
      throw new HttpError(
        429,
        `Cooldown active. Try again after ${new Date(lastPlacement + cooldownMs).toISOString()}.`
      );
    }

    const index = pixelIndex(input.x, input.y);
    const pixelKey = `${STORAGE_PREFIX.pixel}${index}`;
    const existingColor = await this.ctx.storage.get<AllowedColor>(pixelKey);
    const didExist = typeof existingColor === "string";

    if (!didExist) {
      this.meta.pixelCount += 1;
    }

    const updatedAt = new Date(now).toISOString();
    this.meta.updatedAt = updatedAt;
    this.updateBounds(input.x, input.y);
    this.cooldownCache.set(input.agentName, now);
    if (this.pixelsLoaded) {
      this.pixels.set(index, input.color);
    }

    const placement: PlacementRecord = {
      agentName: input.agentName,
      x: input.x,
      y: input.y,
      color: input.color,
      placedAt: updatedAt
    };

    this.recentAgents = [placement, ...this.recentAgents].slice(0, RECENT_AGENT_LIMIT);

    await this.ctx.storage.put({
      [pixelKey]: input.color,
      [`${STORAGE_PREFIX.cooldown}${input.agentName}`]: now,
      [STORAGE_KEYS.meta]: this.meta,
      [STORAGE_KEYS.recentAgents]: this.recentAgents
    });

    return {
      ok: true,
      pixel: {
        x: input.x,
        y: input.y,
        index,
        color: input.color
      },
      nextAvailableAt: new Date(now + cooldownMs).toISOString(),
      state: {
        pixelCount: this.meta.pixelCount,
        updatedAt
      }
    };
  }
}

function getBoardStub(env: Env): DurableObjectStub {
  const boardName = env.ZPLACE_BOARD_NAME || "main";
  return env.BOARD.get(env.BOARD.idFromName(boardName));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (url.pathname === "/info" && request.method === "GET") {
      return json(serviceInfo());
    }

    if (url.pathname === "/contract" && request.method === "GET") {
      return json(serviceContract(url.origin), {
        headers: {
          "Cache-Control": "no-store"
        }
      });
    }

    if (url.pathname === "/api/summary") {
      const stub = getBoardStub(env);
      return stub.fetch("https://board.internal/internal/summary");
    }

    if (url.pathname === "/api/state") {
      const stub = getBoardStub(env);
      return stub.fetch(`https://board.internal/internal/state${url.search}`);
    }

    if (url.pathname === "/api/image") {
      const stub = getBoardStub(env);
      return stub.fetch(`https://board.internal/internal/image${url.search}`);
    }

    if (url.pathname === "/api/place") {
      const stub = getBoardStub(env);
      return stub.fetch("https://board.internal/internal/place", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: await request.text()
      });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const rawBody = await request.text();
      const body = rawBody ? JSON.parse(rawBody) : {};
      const action = parseRunAction(body);
      const stub = getBoardStub(env);
      if (action === "getState") {
        const stateResponse = await stub.fetch("https://board.internal/internal/summary");
        if (!stateResponse.ok) {
          return stateResponse;
        }

        return json({
          ok: true,
          action: "getState",
          state: await stateResponse.json(),
          stateUrl: `${origin}/api/state`,
          imageUrl: `${origin}/api/image`
        });
      }

      return stub.fetch("https://board.internal/internal/place", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: rawBody
      });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json({ error: "Not found." }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
