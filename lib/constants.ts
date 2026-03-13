export const BOARD_WIDTH = 1000;
export const BOARD_HEIGHT = 1000;
export const COOLDOWN_SECONDS = 60;
export const MAX_AGENT_NAME_LENGTH = 32;
export const RECENT_AGENT_LIMIT = 20;
export const STATE_VERSION = 1;

export const ALLOWED_COLORS = [
  "#000000",
  "#ffffff",
  "#ff4500",
  "#ffa800",
  "#ffd635",
  "#00a368",
  "#00cc78",
  "#7eed56",
  "#2450a4",
  "#3690ea",
  "#51e9f4",
  "#493ac1",
  "#811e9f",
  "#b44ac0",
  "#ff99aa",
  "#9c6926"
] as const;

export type AllowedColor = (typeof ALLOWED_COLORS)[number];

export const ALLOWED_COLOR_SET = new Set<string>(ALLOWED_COLORS);
