import type { VercelRequest, VercelResponse } from "@vercel/node";
import { BOARD_HEIGHT, BOARD_WIDTH } from "../lib/constants.js";
import { allowCors, handleOptions, sendError } from "../lib/http.js";
import { getBoardState } from "../lib/storage.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

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
    const rects = state.pixels
      .map(([index, color]) => {
        const x = index % BOARD_WIDTH;
        const y = Math.floor(index / BOARD_WIDTH);
        return `<rect x="${x}" y="${y}" width="1" height="1" fill="${escapeXml(color)}" />`;
      })
      .join("");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}" shape-rendering="crispEdges"><rect width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" fill="#ffffff"/>${rects}</svg>`;
    response.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.status(200).send(svg);
  } catch (error) {
    sendError(response, error);
  }
}
