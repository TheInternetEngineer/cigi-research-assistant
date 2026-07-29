/**
 * Reads every scraped article in data/raw/*.md, splits each into paragraph-
 * aligned chunks, embeds them with OpenAI, and writes the whole thing out as
 * a flat JSON file (data/index.json) that the app loads into memory at
 * request time.
 *
 * No vector database — at this corpus size (a few hundred chunks) an
 * in-memory cosine-similarity search over a JSON array is simpler, has zero
 * external dependencies, and is fast enough that reaching for something like
 * Pinecone would just be adding infrastructure the data size doesn't need.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/build-index.js
 * or put OPENAI_API_KEY in a .env.local file and this script will pick it up.
 *
 * Re-run any time data/raw/ changes — it re-embeds everything from scratch
 * (cheap: text-embedding-3-small is $0.02 per 1M tokens, this corpus is a
 * few hundred thousand tokens at most).
 */

const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const OpenAI = require("openai");

// Lightweight .env.local loader so this behaves the same whether run
// directly or the way Next.js reads env files, without adding a dotenv dep.
function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnvLocal();

const RAW_DIR = path.join(__dirname, "..", "data", "raw");
const OUT_PATH = path.join(__dirname, "..", "data", "index.json");
const EMBEDDING_MODEL = "text-embedding-3-small";
const TARGET_CHUNK_CHARS = 1600; // roughly 250-300 words
const BATCH_SIZE = 100; // chunks per embeddings API call

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "Missing OPENAI_API_KEY. Set it in your shell or in a .env.local file " +
      "(see .env.local.example) and try again."
  );
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Greedily group paragraphs into chunks of ~TARGET_CHUNK_CHARS, never
 * splitting a paragraph in half. Subheadings ("## ...") stick to the start
 * of the chunk they introduce. */
function chunkBody(body) {
  const blocks = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const block of blocks) {
    const isHeading = block.startsWith("## ");
    if (isHeading && current.length > 0) {
      // start a fresh chunk at each subheading so headings introduce their
      // own section rather than getting buried mid-chunk
      chunks.push(current.join("\n\n"));
      current = [];
      currentLen = 0;
    }

    current.push(block);
    currentLen += block.length;

    if (!isHeading && currentLen >= TARGET_CHUNK_CHARS) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentLen = 0;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));

  return chunks;
}

async function embedBatch(texts) {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

async function main() {
  const files = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith(".md"));
  console.log(`Found ${files.length} source files in data/raw/`);

  const records = []; // { id, url, title, date, authors, topics, type, chunkIndex, text }

  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(RAW_DIR, file), "utf-8");
    const { data: fm, content } = matter(raw);

    if (!content || content.trim().length < 50) {
      console.warn(`  SKIP (too short after parsing): ${slug}`);
      continue;
    }

    const chunks = chunkBody(content.trim());
    chunks.forEach((text, i) => {
      records.push({
        id: `${slug}#${i}`,
        slug,
        url: fm.url,
        title: fm.title,
        date: fm.date,
        authors: fm.authors || [],
        topics: fm.topics || [],
        type: fm.type,
        chunkIndex: i,
        text,
      });
    });
    console.log(`  ${slug}: ${chunks.length} chunk(s)`);
  }

  console.log(`\nTotal chunks to embed: ${records.length}`);

  const embeddings = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    console.log(
      `Embedding batch ${i / BATCH_SIZE + 1} (${batch.length} chunks)...`
    );
    const vectors = await embedBatch(batch.map((r) => r.text));
    embeddings.push(...vectors);
  }

  const indexed = records.map((r, i) => ({ ...r, embedding: embeddings[i] }));

  fs.writeFileSync(OUT_PATH, JSON.stringify(indexed));
  const sizeMB = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2);
  console.log(
    `\nWrote ${indexed.length} embedded chunks to data/index.json (${sizeMB} MB)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
