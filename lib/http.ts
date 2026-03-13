import type { VercelRequest, VercelResponse } from "@vercel/node";
import { HttpError } from "./validation.js";

export function allowCors(response: VercelResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function handleOptions(request: VercelRequest, response: VercelResponse): boolean {
  allowCors(response);
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return true;
  }
  return false;
}

export function sendError(response: VercelResponse, error: unknown): void {
  if (error instanceof HttpError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Internal server error.";
  response.status(500).json({ error: message });
}
