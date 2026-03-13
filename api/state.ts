import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getBoardState } from "../lib/storage.js";
import { allowCors, handleOptions, sendError } from "../lib/http.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (handleOptions(request, response)) {
    return;
  }

  allowCors(response);

  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const state = await getBoardState();
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(state);
  } catch (error) {
    sendError(response, error);
  }
}
