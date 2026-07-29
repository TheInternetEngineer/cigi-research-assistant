import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export const MODEL = "claude-sonnet-5";

/** Small helper: send a system+user prompt, get back plain text. */
export async function complete(
  system: string,
  user: string,
  maxTokens: number = 1024
): Promise<string> {
  const anthropic = getAnthropic();
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  // Don't assume the text block is content[0] — other block types (e.g.
  // extended thinking) can come first. Find the actual text block instead
  // of silently returning empty when the assumption is wrong.
  const textBlock = res.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  if (!textBlock) {
    console.warn(
      "No text block in Claude response; block types were:",
      res.content.map((b) => b.type)
    );
  }
  return textBlock?.text ?? "";
}
