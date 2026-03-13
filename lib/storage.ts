import { Redis } from "@upstash/redis";
import { createClient } from "redis";
import {
  ALLOWED_COLORS,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  COOLDOWN_SECONDS,
  RECENT_AGENT_LIMIT,
  STATE_VERSION
} from "./constants.js";
import type { AllowedColor } from "./constants.js";
import type {
  BoardBounds,
  BoardStateResponse,
  PixelTuple,
  PlacementRecord,
  PlacePixelResponse
} from "./types.js";
import { HttpError, pixelIndex } from "./validation.js";

type BoardMeta = {
  pixelCount: number;
  updatedAt: string | null;
  bounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null;
};

type PersistedState = {
  pixels: Record<string, AllowedColor>;
  cooldowns: Record<string, number>;
  recentAgents: PlacementRecord[];
  meta: BoardMeta;
};

type MemoryStore = {
  pixels: Map<number, AllowedColor>;
  cooldowns: Map<string, number>;
  recentAgents: PlacementRecord[];
  meta: BoardMeta;
};

const memoryStore: MemoryStore = {
  pixels: new Map<number, AllowedColor>(),
  cooldowns: new Map<string, number>(),
  recentAgents: [],
  meta: {
    pixelCount: 0,
    updatedAt: null
  }
};

const REDIS_KEYS = {
  pixels: "zplace:pixels",
  cooldowns: "zplace:cooldowns",
  recentAgents: "zplace:recent_agents",
  meta: "zplace:meta"
} as const;

const ARTIFACT_NS = process.env.ZPLACE_ARTIFACT_NS || "zplace:prod";
const ARTIFACT_NAME = process.env.ZPLACE_ARTIFACT_NAME || "board-state.json";
type RedisUrlClient = ReturnType<typeof createClient>;
let redisUrlClientPromise: Promise<RedisUrlClient | null> | null = null;

function getRedisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  return new Redis({ url, token });
}

async function getRedisUrlClient(): Promise<RedisUrlClient | null> {
  const url = process.env.REDIS_URL;
  if (!url) {
    return null;
  }

  if (!redisUrlClientPromise) {
    const client = createClient({ url });
    redisUrlClientPromise = client.connect().then(() => client);
  }

  return redisUrlClientPromise;
}

function getArtifactRunUrl(): string | null {
  return process.env.ZAM_ARTIFACT_RUN_URL || null;
}

function getArtifactAuthHeaders(): Record<string, string> {
  const token = process.env.ZAM_API_KEY || process.env.ZAM_ARTIFACT_API_KEY || "";
  if (!token) return {};
  return {
    "x-zam-api-key": token
  };
}

async function callArtifactStore(payload: Record<string, unknown>): Promise<any> {
  const runUrl = getArtifactRunUrl();
  if (!runUrl) {
    throw new Error("Artifact Store run URL not configured");
  }

  const listingId = process.env.ZAM_ARTIFACT_LISTING_ID || "019cde44-7618-754d-96d5-47e9e1f266ad";
  const body = runUrl.includes("/v1/orders")
    ? { listingId, requestBody: payload }
    : payload;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getArtifactAuthHeaders()
  };

  const resp = await fetch(runUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const raw = await resp.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  if (!resp.ok) {
    const msg = data?.error || data?.message || raw || `Artifact Store failed (${resp.status})`;
    throw new HttpError(resp.status, String(msg));
  }

  // If using orders API and execution is async, poll briefly for result.
  if (runUrl.includes("/v1/orders") && data?.id && data?.orderState && data.orderState !== "completed") {
    const orderUrl = `${new URL(runUrl).origin}/v1/orders/${data.id}`;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const pollResp = await fetch(orderUrl, { headers });
      const pollRaw = await pollResp.text();
      let pollData: any = null;
      try {
        pollData = pollRaw ? JSON.parse(pollRaw) : null;
      } catch {
        pollData = { raw: pollRaw };
      }
      if (!pollResp.ok) continue;
      if (pollData?.orderState === "completed") {
        return pollData?.result ?? pollData;
      }
      if (pollData?.orderState === "failed") {
        throw new HttpError(502, String(pollData?.errorMessage || "Artifact Store order failed"));
      }
    }
    return data?.result ?? data;
  }

  if (data?.result) {
    return data.result;
  }

  if (data?.error) {
    throw new HttpError(502, String(data.error));
  }

  return data;
}

function toBoardState(
  pixels: PixelTuple[],
  meta: BoardMeta,
  recentAgents: PlacementRecord[]
): BoardStateResponse {
  const bounds =
    meta.bounds ??
    pixels.reduce<BoardBounds | null>((acc, [index]) => {
      const x = index % BOARD_WIDTH;
      const y = Math.floor(index / BOARD_WIDTH);
      if (!acc) {
        return { minX: x, minY: y, maxX: x, maxY: y };
      }

      return {
        minX: Math.min(acc.minX, x),
        minY: Math.min(acc.minY, y),
        maxX: Math.max(acc.maxX, x),
        maxY: Math.max(acc.maxY, y)
      };
    }, null);

  return {
    width: BOARD_WIDTH,
    height: BOARD_HEIGHT,
    cooldownSeconds: COOLDOWN_SECONDS,
    palette: ALLOWED_COLORS,
    pixelCount: meta.pixelCount,
    updatedAt: meta.updatedAt,
    bounds,
    recentAgents,
    pixels,
    version: STATE_VERSION
  };
}

function parseMeta(rawMeta: Record<string, unknown> | null): BoardMeta {
  return {
    pixelCount: Number(rawMeta?.pixelCount ?? 0),
    updatedAt: typeof rawMeta?.updatedAt === "string" ? rawMeta.updatedAt : null,
    bounds: rawMeta?.bounds && typeof rawMeta.bounds === "object" ? (rawMeta.bounds as BoardMeta["bounds"]) : null
  };
}

function emptyPersistedState(): PersistedState {
  return {
    pixels: {},
    cooldowns: {},
    recentAgents: [],
    meta: {
      pixelCount: 0,
      updatedAt: null,
      bounds: null
    }
  };
}

function normalizePersistedState(raw: any): PersistedState {
  const base = emptyPersistedState();
  if (!raw || typeof raw !== "object") return base;

  const pixels = raw.pixels && typeof raw.pixels === "object" ? raw.pixels : {};
  const cooldowns = raw.cooldowns && typeof raw.cooldowns === "object" ? raw.cooldowns : {};
  const recentAgents = Array.isArray(raw.recentAgents) ? raw.recentAgents : [];
  const meta = parseMeta(raw.meta && typeof raw.meta === "object" ? raw.meta : null);

  return {
    pixels,
    cooldowns,
    recentAgents,
    meta
  };
}

function toPersistedJson(state: PersistedState): string {
  return JSON.stringify(state);
}

async function getStateFromArtifactStore(): Promise<BoardStateResponse> {
  let payload: any = null;
  try {
    payload = await callArtifactStore({
      action: "get",
      ns: ARTIFACT_NS,
      name: ARTIFACT_NAME
    });
  } catch (err) {
    if (
      err instanceof HttpError &&
      (err.statusCode === 404 || String(err.message).includes("404"))
    ) {
      return toBoardState([], { pixelCount: 0, updatedAt: null }, []);
    }
    throw err;
  }

  const rawContent =
    payload?.content ??
    payload?.artifact?.content ??
    payload?.item?.content ??
    payload?.data?.content ??
    null;

  if (!rawContent || typeof rawContent !== "string") {
    return toBoardState([], { pixelCount: 0, updatedAt: null }, []);
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    parsed = null;
  }

  const state = normalizePersistedState(parsed);
  const pixels: PixelTuple[] = Object.entries(state.pixels)
    .map(([index, color]) => [Number(index), color] as PixelTuple)
    .sort((a, b) => a[0] - b[0]);

  return toBoardState(pixels, state.meta, state.recentAgents.slice(0, RECENT_AGENT_LIMIT));
}

async function placePixelInArtifactStore(input: {
  x: number;
  y: number;
  color: AllowedColor;
  agentName: string;
}): Promise<PlacePixelResponse> {
  const now = Date.now();
  const cooldownMs = COOLDOWN_SECONDS * 1000;

  let current: PersistedState = emptyPersistedState();
  try {
    const getPayload = await callArtifactStore({
      action: "get",
      ns: ARTIFACT_NS,
      name: ARTIFACT_NAME
    });
    const rawContent =
      getPayload?.content ??
      getPayload?.artifact?.content ??
      getPayload?.item?.content ??
      getPayload?.data?.content ??
      null;
    if (typeof rawContent === "string") {
      current = normalizePersistedState(JSON.parse(rawContent));
    }
  } catch (err) {
    if (
      err instanceof HttpError &&
      (err.statusCode === 404 || String(err.message).includes("404"))
    ) {
      // treat missing artifact as empty initial state
    } else {
      throw err;
    }
  }

  const lastPlacement = Number(current.cooldowns[input.agentName] ?? 0);
  if (now - lastPlacement < cooldownMs) {
    throw new HttpError(
      429,
      `Cooldown active. Try again after ${new Date(lastPlacement + cooldownMs).toISOString()}.`
    );
  }

  const index = pixelIndex(input.x, input.y);
  const indexKey = String(index);
  const didExist = Boolean(current.pixels[indexKey]);

  current.pixels[indexKey] = input.color;
  if (!didExist) current.meta.pixelCount += 1;

  current.cooldowns[input.agentName] = now;
  const updatedAt = new Date(now).toISOString();
  current.meta.updatedAt = updatedAt;

  const placement: PlacementRecord = {
    agentName: input.agentName,
    x: input.x,
    y: input.y,
    color: input.color,
    placedAt: updatedAt
  };

  current.recentAgents = [placement, ...current.recentAgents].slice(0, RECENT_AGENT_LIMIT);

  await callArtifactStore({
    action: "put",
    ns: ARTIFACT_NS,
    name: ARTIFACT_NAME,
    content_type: "application/json",
    content: toPersistedJson(current),
    tags: ["zplace", "board-state"]
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
      pixelCount: current.meta.pixelCount,
      updatedAt
    }
  };
}

async function getStateFromMemory(): Promise<BoardStateResponse> {
  const pixels = [...memoryStore.pixels.entries()].sort((a, b) => a[0] - b[0]);
  return toBoardState(pixels, memoryStore.meta, memoryStore.recentAgents);
}

async function placePixelInMemory(input: {
  x: number;
  y: number;
  color: AllowedColor;
  agentName: string;
}): Promise<PlacePixelResponse> {
  const now = Date.now();
  const lastPlacement = memoryStore.cooldowns.get(input.agentName) ?? 0;
  const cooldownMs = COOLDOWN_SECONDS * 1000;

  if (now - lastPlacement < cooldownMs) {
    throw new HttpError(
      429,
      `Cooldown active. Try again after ${new Date(lastPlacement + cooldownMs).toISOString()}.`
    );
  }

  const index = pixelIndex(input.x, input.y);
  const didExist = memoryStore.pixels.has(index);
  memoryStore.pixels.set(index, input.color);
  if (!didExist) {
    memoryStore.meta.pixelCount += 1;
  }

  memoryStore.cooldowns.set(input.agentName, now);
  const updatedAt = new Date(now).toISOString();
  memoryStore.meta.updatedAt = updatedAt;

  const placement: PlacementRecord = {
    agentName: input.agentName,
    x: input.x,
    y: input.y,
    color: input.color,
    placedAt: updatedAt
  };

  memoryStore.recentAgents = [placement, ...memoryStore.recentAgents].slice(0, RECENT_AGENT_LIMIT);

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
      pixelCount: memoryStore.meta.pixelCount,
      updatedAt
    }
  };
}

async function getStateFromRedis(redis: Redis): Promise<BoardStateResponse> {
  const [pixelsRaw, recentAgentsRaw, metaRaw] = await Promise.all([
    redis.hgetall<Record<string, AllowedColor>>(REDIS_KEYS.pixels),
    redis.lrange<string>(REDIS_KEYS.recentAgents, 0, RECENT_AGENT_LIMIT - 1),
    redis.hgetall<Record<string, string>>(REDIS_KEYS.meta)
  ]);

  const pixels: PixelTuple[] = Object.entries(pixelsRaw ?? {})
    .map(([index, color]) => [Number(index), color] as PixelTuple)
    .sort((a, b) => a[0] - b[0]);

  const recentAgents = (recentAgentsRaw ?? []).map((entry) => JSON.parse(entry) as PlacementRecord);
  return toBoardState(pixels, parseMeta(metaRaw), recentAgents);
}

async function getStateFromRedisUrl(redis: RedisUrlClient): Promise<BoardStateResponse> {
  const [pixelsRaw, recentAgentsRaw, metaRaw] = await Promise.all([
    redis.hGetAll(REDIS_KEYS.pixels),
    redis.lRange(REDIS_KEYS.recentAgents, 0, RECENT_AGENT_LIMIT - 1),
    redis.hGetAll(REDIS_KEYS.meta)
  ]);

  const pixels: PixelTuple[] = Object.entries(pixelsRaw ?? {})
    .map(([index, color]) => [Number(index), color as AllowedColor] as PixelTuple)
    .sort((a, b) => a[0] - b[0]);

  const recentAgents = (recentAgentsRaw ?? []).map((entry) => JSON.parse(entry) as PlacementRecord);
  return toBoardState(pixels, parseMeta(metaRaw), recentAgents);
}

async function placePixelInRedis(
  redis: Redis,
  input: { x: number; y: number; color: AllowedColor; agentName: string }
): Promise<PlacePixelResponse> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cooldownMs = COOLDOWN_SECONDS * 1000;
  const cooldownKey = `${REDIS_KEYS.cooldowns}:${input.agentName}`;
  const cooldownSet = await redis.set(cooldownKey, now, {
    ex: COOLDOWN_SECONDS,
    nx: true
  });

  if (cooldownSet !== "OK") {
    const lastPlacement = await redis.get<number>(cooldownKey);
    const retryAt = typeof lastPlacement === "number" ? lastPlacement + cooldownMs : now + cooldownMs;
    throw new HttpError(429, `Cooldown active. Try again after ${new Date(retryAt).toISOString()}.`);
  }

  const index = pixelIndex(input.x, input.y);
  const pixelField = String(index);
  const fieldsAdded = await redis.hset(REDIS_KEYS.pixels, { [pixelField]: input.color });

  const placement: PlacementRecord = {
    agentName: input.agentName,
    x: input.x,
    y: input.y,
    color: input.color,
    placedAt: nowIso
  };

  await Promise.all([
    redis.lpush(REDIS_KEYS.recentAgents, JSON.stringify(placement)),
    redis.ltrim(REDIS_KEYS.recentAgents, 0, RECENT_AGENT_LIMIT - 1),
    redis.hset(REDIS_KEYS.meta, { updatedAt: nowIso }),
    fieldsAdded > 0 ? redis.hincrby(REDIS_KEYS.meta, "pixelCount", 1) : Promise.resolve("ok")
  ]);

  const metaRaw = await redis.hgetall<Record<string, string>>(REDIS_KEYS.meta);
  const meta = parseMeta(metaRaw);

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
      pixelCount: meta.pixelCount,
      updatedAt: nowIso
    }
  };
}

async function placePixelInRedisUrl(
  redis: RedisUrlClient,
  input: { x: number; y: number; color: AllowedColor; agentName: string }
): Promise<PlacePixelResponse> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cooldownMs = COOLDOWN_SECONDS * 1000;
  const cooldownKey = `${REDIS_KEYS.cooldowns}:${input.agentName}`;
  const cooldownSet = await redis.set(cooldownKey, String(now), {
    EX: COOLDOWN_SECONDS,
    NX: true
  });

  if (cooldownSet !== "OK") {
    const lastPlacement = await redis.get(cooldownKey);
    const retryAt =
      typeof lastPlacement === "string" ? Number(lastPlacement) + cooldownMs : now + cooldownMs;
    throw new HttpError(429, `Cooldown active. Try again after ${new Date(retryAt).toISOString()}.`);
  }

  const index = pixelIndex(input.x, input.y);
  const pixelField = String(index);
  const fieldsAdded = await redis.hSet(REDIS_KEYS.pixels, pixelField, input.color);

  const placement: PlacementRecord = {
    agentName: input.agentName,
    x: input.x,
    y: input.y,
    color: input.color,
    placedAt: nowIso
  };

  await Promise.all([
    redis.lPush(REDIS_KEYS.recentAgents, JSON.stringify(placement)),
    redis.lTrim(REDIS_KEYS.recentAgents, 0, RECENT_AGENT_LIMIT - 1),
    redis.hSet(REDIS_KEYS.meta, "updatedAt", nowIso),
    fieldsAdded > 0 ? redis.hIncrBy(REDIS_KEYS.meta, "pixelCount", 1) : Promise.resolve(0)
  ]);

  const metaRaw = await redis.hGetAll(REDIS_KEYS.meta);
  const meta = parseMeta(metaRaw);

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
      pixelCount: meta.pixelCount,
      updatedAt: nowIso
    }
  };
}

export async function getBoardState(): Promise<BoardStateResponse> {
  const redisUrlClient = await getRedisUrlClient();
  if (redisUrlClient) {
    return getStateFromRedisUrl(redisUrlClient);
  }

  const redis = getRedisClient();
  if (redis) {
    return getStateFromRedis(redis);
  }

  const artifactUrl = getArtifactRunUrl();
  if (artifactUrl) {
    return getStateFromArtifactStore();
  }

  return getStateFromMemory();
}

export async function placePixel(input: {
  x: number;
  y: number;
  color: AllowedColor;
  agentName: string;
}): Promise<PlacePixelResponse> {
  const redisUrlClient = await getRedisUrlClient();
  if (redisUrlClient) {
    return placePixelInRedisUrl(redisUrlClient, input);
  }

  const redis = getRedisClient();
  if (redis) {
    return placePixelInRedis(redis, input);
  }

  const artifactUrl = getArtifactRunUrl();
  if (artifactUrl) {
    return placePixelInArtifactStore(input);
  }

  return placePixelInMemory(input);
}
