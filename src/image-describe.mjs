// Jev reads text only, so images in a new turn are turned into short descriptions by the
// CLI's cheapest vision model and appended to the prompt Jev routes on. The request sent to
// the working model is left untouched: descriptions are routing input, nothing more.

export const DESCRIBE_MAX_IMAGES = 4;
export const DESCRIPTION_MAX_CHARS = 400;
export const DESCRIBE_DEADLINE_MS = 4000;
// A prompt this long already tells Jev what the task is, so the description (up to the
// deadline above) is skipped and the turn routes at text speed. Shorter prompts such as
// "check this image" carry too little for Jev to judge, so the image is read first.
export const DESCRIBE_PROMPT_MIN_CHARS = 200;

// Placeholders the CLIs write into the text for an attached image. They carry a path, not the
// task, and would push a three-word prompt over the length line on their own.
const IMAGE_PLACEHOLDERS = [
  /<image\b[^>]*>[\s\S]*?<\/image>/gi, // Codex: <image name=[Image #1] path="…"></image>
  /\[Image(?::\s*source:[^\]]*| #\d+)\]/gi, // Claude Code: [Image: source: …] and [Image #1]
];

/** Whether a turn's own text (image paths and placeholders removed) is too thin to route without the image. */
export const shouldDescribeImages = (text) =>
  IMAGE_PLACEHOLDERS.reduce((rest, pattern) => rest.replace(pattern, ""), String(text ?? "")).trim().length <
  DESCRIBE_PROMPT_MIN_CHARS;

export const describeInstruction = (count) =>
  "Describe each image factually in ≤ 60 words: what UI/code/error is shown, visible text, and anything broken.\n" +
  `Reply with exactly ${count} line(s), "Image N: <description>", in order.`;

/** One description (or null) per image from a model reply, or null when nothing parsed. */
export function parseDescriptions(text, count) {
  const lines = new Map();
  for (const [, n, line] of String(text ?? "").matchAll(/^\s*\**Image\s*(\d+)\**\s*[:.-]\s*(.+?)\s*$/gim)) {
    lines.set(Number(n), line);
  }
  const found = Array.from({ length: count }, (_, i) => {
    const line = lines.get(i + 1) ?? (count === 1 ? String(text ?? "").trim().replace(/\s+/g, " ") : "");
    return line ? (line.length > DESCRIPTION_MAX_CHARS ? `${line.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : line) : null;
  });
  return found.some(Boolean) ? found : null;
}

/** Jev's view of the prompt: the user's text followed by what each image shows. */
export function withImageDescriptions(prompt, count, descriptions) {
  if (!count) return prompt;
  const lines = Array.from({ length: count }, (_, i) => descriptions?.[i]
    ? `[image ${i + 1}: ${descriptions[i]}]`
    : `[image ${i + 1} attached, not described]`);
  return `${prompt ?? ""}\n\n${lines.join("\n")}`.trim();
}

// Headers that belong to one connection or one body, never forwarded to another request.
const HOP_HEADERS = ["host", "content-length", "transfer-encoding", "connection", "accept-encoding", "keep-alive", "upgrade"];
export const describeHeaders = (incoming) => {
  const headers = { ...incoming };
  for (const name of HOP_HEADERS) delete headers[name];
  return headers;
};
