import fs from "fs";
import path from "path";
import OpenAI from "openai";

export type Chunk = {
  id: string;
  slug: string;
  url: string;
  title: string;
  date: string;
  authors: string[];
  topics: string[];
  type: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
};

const EMBEDDING_MODEL = "text-embedding-3-small";

let cachedIndex: Chunk[] | null = null;

/** Loads data/index.json once per warm serverless instance, not per request. */
export function loadIndex(): Chunk[] {
  if (cachedIndex) return cachedIndex;
  const indexPath = path.join(process.cwd(), "data", "index.json");
  const raw = fs.readFileSync(indexPath, "utf-8");
  cachedIndex = JSON.parse(raw) as Chunk[];
  return cachedIndex;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

export async function embedQuery(query: string): Promise<number[]> {
  const client = getOpenAI();
  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: query,
  });
  return res.data[0].embedding;
}

export type RetrievedChunk = Chunk & { score: number };

const STOPWORDS = new Set([
  "the", "is", "are", "a", "an", "of", "on", "in", "to", "and", "or", "does",
  "do", "did", "what", "how", "why", "when", "where", "who", "research",
  "say", "says", "said", "cigi", "about", "mention", "mentions",
  "mentioned", "any", "there", "this", "that", "for", "with", "was", "were",
]);

/** Pulls out the distinctive words from a query — names, places, specific
 * terms — that a pure semantic-similarity match can under-rank if they're
 * buried in a chunk that's mostly about something else. */
function distinctiveTerms(query: string): string[] {
  const words = query.match(/[A-Za-z][A-Za-z'-]+/g) || [];
  return [...new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase())))];
}

function lexicalOverlap(terms: string[], text: string): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  const hits = terms.filter((t) => lower.includes(t.toLowerCase())).length;
  return hits / terms.length;
}

/** Hybrid retrieval: cosine similarity over embeddings, plus a lexical
 * overlap boost for exact keyword/name matches. Pure embedding search
 * under-ranks specific proper-noun lookups when the matching sentence is
 * one of several buried in a longer chunk (a real failure case found while
 * testing this app: a query naming a specific person mentioned once in a
 * chunk about several different incidents scored lower on cosine similarity
 * than more generically on-topic chunks). The lexical term-overlap score
 * corrects for that without needing a separate keyword-search index — at
 * this corpus size, checking substring matches against every chunk is
 * effectively free. No vector database needed either way. */
export function retrieve(
  queryEmbedding: number[],
  k: number = 6,
  queryText?: string
): RetrievedChunk[] {
  const index = loadIndex();
  const terms = queryText ? distinctiveTerms(queryText) : [];
  const scored = index.map((chunk) => {
    const cosine = cosineSimilarity(queryEmbedding, chunk.embedding);
    const lexical = lexicalOverlap(terms, chunk.text);
    return { ...chunk, score: cosine + lexical * 0.3 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Groups retrieved chunks back into per-article numbered sources, in the
 * order they should be presented to the model as context. Multiple chunks
 * from the same article get merged into one numbered source with combined
 * text, so citations refer to articles, not arbitrary chunk fragments. */
export function buildSourceList(chunks: RetrievedChunk[]) {
  const bySlug = new Map<string, RetrievedChunk[]>();
  for (const c of chunks) {
    if (!bySlug.has(c.slug)) bySlug.set(c.slug, []);
    bySlug.get(c.slug)!.push(c);
  }
  // Order articles by their best (max) chunk score.
  const ordered = [...bySlug.entries()].sort((a, b) => {
    const bestA = Math.max(...a[1].map((c) => c.score));
    const bestB = Math.max(...b[1].map((c) => c.score));
    return bestB - bestA;
  });

  return ordered.map(([slug, group], i) => {
    group.sort((a, b) => a.chunkIndex - b.chunkIndex);
    return {
      n: i + 1,
      slug,
      title: group[0].title,
      url: group[0].url,
      date: group[0].date,
      authors: group[0].authors,
      type: group[0].type,
      text: group.map((c) => c.text).join("\n\n"),
      score: Math.max(...group.map((c) => c.score)),
    };
  });
}
