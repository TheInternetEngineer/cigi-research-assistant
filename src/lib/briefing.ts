import { embedQuery, retrieve, buildSourceList } from "./retrieval";
import { complete } from "./anthropic";

/**
 * "Briefing mode": a small agentic pipeline rather than a single retrieve-
 * then-answer call.
 *
 *   1. PLAN    — break the topic into a handful of focused sub-questions.
 *   2. RESEARCH — for each sub-question, retrieve sources and have the model
 *                self-assess whether what it got back is actually enough to
 *                say something substantive. If not, it widens the search
 *                once before moving on rather than answering thin.
 *   3. SYNTHESIZE — combine every sub-question's findings into one briefing,
 *                with a single deduplicated source list at the end.
 *
 * This mirrors a plan → retrieve → self-assess → retry-or-continue loop
 * (the same shape as a LangGraph-style agent), implemented here as plain
 * sequential async calls since the corpus and use case don't need a graph
 * framework's overhead to get the behaviour that matters: the agent checking
 * its own work before committing to an answer.
 */

const PLAN_SYSTEM_PROMPT = `You help scope research briefings. Given a topic or question, break it into 3 to 5 focused sub-questions that, taken together, would produce a well-rounded briefing on the topic. Sub-questions should be specific enough to research individually (not vague restatements of the topic). Reply with ONLY a numbered list, one sub-question per line, nothing else.`;

const SUFFICIENCY_SYSTEM_PROMPT = `You are deciding whether a set of source excerpts gives enough real information to substantively answer a specific sub-question. Reply with ONLY one word: SUFFICIENT or INSUFFICIENT.`;

const SUBANSWER_SYSTEM_PROMPT = `You are drafting one section of a research briefing using only the numbered source excerpts provided. Write 2-4 sentences of clear, well-supported prose directly answering the sub-question. Cite inline as you go: whenever you state something a source told you, put that source's bracket number right after it, like [1] or [2][3]. Do not use outside knowledge. If the sources only partially cover it, say what they do cover and note the gap honestly. At the end, on its own line, output exactly:
SOURCES_USED: [n, n, ...]`;

const SYNTHESIS_SYSTEM_PROMPT = `You write the executive framing for a research briefing. You'll be given a topic and a set of already-researched sub-sections (each with its own finding). Write a short introduction (2-3 sentences) that frames why this topic matters and previews what the briefing covers. Do not repeat the sub-section content in detail — that follows separately. Do not add any new facts beyond what's implied by the section titles.`;

function parsePlan(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

function parseSourcesUsed(raw: string): { text: string; usedNumbers: number[] } {
  const match = raw.match(/SOURCES_USED:\s*\[([^\]]*)\]\s*$/);
  if (match) {
    const text = raw.slice(0, match.index).trim();
    const usedNumbers = match[1]
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    return { text, usedNumbers };
  }
  // Same truncation fallback as ask.ts: if the trailing marker got cut off
  // by the token limit, recover citations from the inline [n] markers
  // already written into the text instead of dropping them all.
  const text = raw.trim();
  const usedNumbers = [
    ...new Set(
      [...text.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10))
    ),
  ];
  return { text, usedNumbers };
}

function formatSourcesBlock(sources: ReturnType<typeof buildSourceList>): string {
  return sources
    .map(
      (s) =>
        `[${s.n}] ${s.title} (${s.authors.join(", ")}, ${s.date})\n${s.text}`
    )
    .join("\n\n---\n\n");
}

// Citation numbers (`n`) are global across the whole briefing, not scoped
// per section: each sub-question researches independently and gets its own
// [1], [2]... numbering from its own retrieval, but runBriefing() renumbers
// every section's citations against one shared, deduplicated source list
// before returning. That keeps "[6]" meaning the same thing everywhere in
// the briefing and matching the final numbered bibliography exactly — a
// reader shouldn't need to hover a footnote to find out what it refers to.
export type BriefingSection = {
  subQuestion: string;
  finding: string;
  sourcesUsed: Array<{ n: number; title: string; url: string; date: string; authors: string[] }>;
  coverage: "sufficient" | "widened" | "thin";
};

export type BriefingResult = {
  topic: string;
  intro: string;
  sections: BriefingSection[];
  allSources: Array<{ n: number; title: string; url: string; date: string; authors: string[] }>;
};

async function researchSubQuestion(subQuestion: string): Promise<BriefingSection> {
  // Embed once and reuse — the widened retry re-scores the same embedding
  // against a larger k, it doesn't need a fresh embedding call.
  const queryEmbedding = await embedQuery(subQuestion);

  let k = 6;
  let retrieved = retrieve(queryEmbedding, k, subQuestion);
  let sources = buildSourceList(retrieved);

  const sufficiencyCheck = await complete(
    SUFFICIENCY_SYSTEM_PROMPT,
    `SUB-QUESTION: ${subQuestion}\n\nSOURCES:\n\n${formatSourcesBlock(sources)}`,
    10
  );

  let coverage: BriefingSection["coverage"] = "sufficient";
  if (!sufficiencyCheck.toUpperCase().includes("SUFFICIENT") || sufficiencyCheck.toUpperCase().includes("INSUFFICIENT")) {
    // widen the search once before giving up
    k = 12;
    retrieved = retrieve(queryEmbedding, k, subQuestion);
    sources = buildSourceList(retrieved);
    coverage = "widened";

    const recheck = await complete(
      SUFFICIENCY_SYSTEM_PROMPT,
      `SUB-QUESTION: ${subQuestion}\n\nSOURCES:\n\n${formatSourcesBlock(sources)}`,
      10
    );
    if (recheck.toUpperCase().includes("INSUFFICIENT")) {
      coverage = "thin";
    }
  }

  const raw = await complete(
    SUBANSWER_SYSTEM_PROMPT,
    `SUB-QUESTION: ${subQuestion}\n\nSOURCES:\n\n${formatSourcesBlock(sources)}`,
    600
  );
  const { text, usedNumbers } = parseSourcesUsed(raw);
  const usedSources = sources.filter((s) => usedNumbers.includes(s.n));

  return {
    subQuestion,
    finding: text,
    sourcesUsed: usedSources.map((s) => ({
      n: s.n,
      title: s.title,
      url: s.url,
      date: s.date,
      authors: s.authors,
    })),
    coverage,
  };
}

export async function runBriefing(topic: string): Promise<BriefingResult> {
  const planRaw = await complete(PLAN_SYSTEM_PROMPT, `TOPIC: ${topic}`, 300);
  const subQuestions = parsePlan(planRaw).slice(0, 5);

  // Sub-questions are independent of each other — researching them in
  // parallel instead of one at a time is what actually keeps this under a
  // serverless function's time limit. Sequentially, 5 sub-questions at up to
  // 4 model/embedding calls each stacks into 15-20+ calls end to end, which
  // is exactly what was timing out in production. In parallel, wall-clock
  // time is roughly bounded by the slowest single sub-question, not the sum
  // of all of them.
  const sections: BriefingSection[] = await Promise.all(
    subQuestions.map((sq) => researchSubQuestion(sq))
  );

  const sectionSummary = sections
    .map((s, i) => `${i + 1}. ${s.subQuestion}`)
    .join("\n");
  const intro = await complete(
    SYNTHESIS_SYSTEM_PROMPT,
    `TOPIC: ${topic}\n\nSUB-SECTIONS COVERED:\n${sectionSummary}`,
    250
  );

  // Assign one global citation number per unique source (by URL), in the
  // order each is first used across sections.
  const globalNumber = new Map<string, number>();
  const allSources: BriefingResult["allSources"] = [];
  for (const s of sections) {
    for (const src of s.sourcesUsed) {
      if (!globalNumber.has(src.url)) {
        const n = allSources.length + 1;
        globalNumber.set(src.url, n);
        allSources.push({ n, title: src.title, url: src.url, date: src.date, authors: src.authors });
      }
    }
  }

  // Rewrite each section's own local [n] citation markers (and sourcesUsed
  // numbering) to the shared global numbers just assigned.
  const renumberedSections: BriefingSection[] = sections.map((s) => {
    const localToGlobal = new Map<number, number>();
    for (const src of s.sourcesUsed) {
      localToGlobal.set(src.n, globalNumber.get(src.url)!);
    }
    const finding = s.finding.replace(/\[(\d+)\]/g, (whole, numStr) => {
      const g = localToGlobal.get(parseInt(numStr, 10));
      return g ? `[${g}]` : whole;
    });
    return {
      ...s,
      finding,
      sourcesUsed: s.sourcesUsed.map((src) => ({
        ...src,
        n: globalNumber.get(src.url)!,
      })),
    };
  });

  return {
    topic,
    intro: intro.trim(),
    sections: renumberedSections,
    allSources,
  };
}
