import type { VercelRequest, VercelResponse } from "@vercel/node";
import { allowCors, handleOptions, sendError } from "../lib/http.js";
import { placePixel } from "../lib/storage.js";
import { parsePlacePixelInput } from "../lib/validation.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (handleOptions(request, response)) {
    return;
  }

  allowCors(response);

  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const input = parsePlacePixelInput(request.body);
    const result = await placePixel(input);
    response.status(200).json(result);
  } catch (error) {
    sendError(response, error);
  }
}
