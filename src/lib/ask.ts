import { embedQuery, retrieve, buildSourceList } from "./retrieval";
import { complete } from "./anthropic";

const ASK_SYSTEM_PROMPT = `You are a research assistant answering questions using a small set of real, numbered source excerpts drawn from public CIGI (Centre for International Governance Innovation) research and commentary. This is an independent demo, not an official CIGI product.

Rules:
- Answer only using information contained in the numbered sources below. Do not bring in outside knowledge, and do not guess at facts the sources don't contain.
- Cite inline as you go: whenever you state something a source told you, put that source's bracket number right after it, like [1] or [2][3]. Every substantive claim should trace back to a bracket.
- If the sources don't give you enough to answer the question with real confidence, say so plainly rather than filling the gap with a plausible-sounding guess. It is better to say "the sources I have don't cover this" than to be wrong.
- Write in clear, well-organized prose — a short paragraph or two is usually right, three at most for a genuinely broad question. Do not break the answer into bolded sub-headings or turn it into a multi-part report; this is a conversational answer, not a briefing document. Only use a list if the question specifically asks for one.
- At the very end of your reply, on its own line with nothing else on it, output exactly:
SOURCES_USED: [n, n, ...]
listing only the numbers of sources you actually drew on to write the answer, in the order you first used them. If you could not answer from the sources at all, output SOURCES_USED: []`;

function formatSourcesBlock(
  sources: ReturnType<typeof buildSourceList>
): string {
  return sources
    .map(
      (s) =>
        `[${s.n}] ${s.title} (${s.authors.join(", ")}, ${s.date})\n${s.text}`
    )
    .join("\n\n---\n\n");
}

function parseSourcesUsed(raw: string): { answer: string; usedNumbers: number[] } {
  const match = raw.match(/SOURCES_USED:\s*\[([^\]]*)\]\s*$/);
  if (match) {
    const answer = raw.slice(0, match.index).trim();
    const usedNumbers = match[1]
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    return { answer, usedNumbers };
  }
  // No trailing marker — most likely the response got cut off by the token
  // limit before the model could write it (a long, well-cited answer can run
  // out of budget one line early). Rather than silently dropping every
  // citation, fall back to the inline [n] markers already embedded in the
  // text as the model wrote it, so the answer still cites correctly even
  // when the trailer is missing.
  const answer = raw.trim();
  const usedNumbers = [
    ...new Set(
      [...answer.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10))
    ),
  ];
  return { answer, usedNumbers };
}

export type AskResult = {
  answer: string;
  sources: Array<{
    n: number;
    title: string;
    url: string;
    date: string;
    authors: string[];
  }>;
  retrievedCount: number;
};

export async function askQuestion(question: string): Promise<AskResult> {
  const queryEmbedding = await embedQuery(question);
  const retrieved = retrieve(queryEmbedding, 8, question);
  const sources = buildSourceList(retrieved);

  const userPrompt = `SOURCES:\n\n${formatSourcesBlock(sources)}\n\nQUESTION: ${question}`;

  const raw = await complete(ASK_SYSTEM_PROMPT, userPrompt, 1300);
  const { answer, usedNumbers } = parseSourcesUsed(raw);

  // Only surface sources the model actually says it used — this is the
  // credibility check: instead of trusting a similarity-score cutoff to
  // decide what counts as "relevant enough to cite," the model reports
  // which of the retrieved sources it actually leaned on to write the
  // answer, and that self-report is what gets shown, not the raw retrieval
  // list.
  const usedSources = sources.filter((s) => usedNumbers.includes(s.n));

  return {
    answer,
    sources: usedSources.map((s) => ({
      n: s.n,
      title: s.title,
      url: s.url,
      date: s.date,
      authors: s.authors,
    })),
    retrievedCount: retrieved.length,
  };
}
