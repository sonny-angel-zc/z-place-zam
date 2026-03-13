import type { AllowedColor } from "./constants.js";

export type PixelTuple = [index: number, color: AllowedColor];

export interface BoardBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PlacementRecord {
  agentName: string;
  x: number;
  y: number;
  color: AllowedColor;
  placedAt: string;
}

export interface PlacePixelInput {
  x: number;
  y: number;
  color: string;
  agentName: string;
}

export interface BoardStateResponse {
  width: number;
  height: number;
  cooldownSeconds: number;
  palette: readonly AllowedColor[];
  pixelCount: number;
  updatedAt: string | null;
  bounds: BoardBounds | null;
  recentAgents: PlacementRecord[];
  pixels: PixelTuple[];
  version: number;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isPartial?: boolean;
}

export interface PlacePixelResponse {
  ok: true;
  pixel: {
    x: number;
    y: number;
    index: number;
    color: AllowedColor;
  };
  nextAvailableAt: string;
  state: {
    pixelCount: number;
    updatedAt: string;
  };
}
