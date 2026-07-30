"use client";

import { useState, useRef } from "react";

type Source = {
  n: number;
  title: string;
  url: string;
  date: string;
  authors: string[];
};

type AskResult = {
  answer: string;
  sources: Source[];
  retrievedCount: number;
};

type BriefingSection = {
  subQuestion: string;
  finding: string;
  sourcesUsed: Source[];
  coverage: "sufficient" | "widened" | "thin";
};

type BriefingResult = {
  topic: string;
  intro: string;
  sections: BriefingSection[];
  allSources: Source[];
};

type Mode = "ask" | "briefing";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function FootnoteMarker({
  n,
  source,
  onJump,
}: {
  n: number;
  source: Source | undefined;
  onJump: (source: Source) => void;
}) {
  if (!source) {
    // Model cited a number that doesn't map to a known source — render
    // plainly rather than a broken interactive element.
    return <span className="text-ink-faint">[{n}]</span>;
  }
  return (
    <span className="relative group not-italic">
      <button
        type="button"
        onClick={() => onJump(source)}
        className="inline-flex items-baseline font-mono text-[0.7rem] font-medium text-gold align-super leading-none px-0.5 hover:text-wine transition-colors cursor-pointer"
        aria-label={`Jump to source ${n}: ${source.title}`}
      >
        [{n}]
      </button>
      {/* select-none + aria-hidden: this is a hover preview only. Without
          select-none, the browser still includes this text (opacity:0 is a
          paint-only property, not a layout/selection one) when a user
          selects and copies the surrounding paragraph — which is exactly
          what produced garbled "[4]Some Title...Author · Date" text glued
          into copied briefing output. */}
      <span
        role="tooltip"
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 select-none rounded-sm border border-line bg-paper-raised p-3 text-left opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100"
      >
        <span className="block font-serif text-sm leading-snug text-ink">
          {source.title}
        </span>
        <span className="mt-1 block font-sans text-xs text-ink-soft">
          {source.authors.join(", ")} · {formatDate(source.date)}
        </span>
      </span>
    </span>
  );
}

function FootnoteText({
  text,
  sources,
  onJump,
}: {
  text: string;
  sources: Source[];
  onJump: (source: Source) => void;
}) {
  const bySn = new Map(sources.map((s) => [s.n, s]));
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());

  return (
    <div className="space-y-4">
      {paragraphs.map((para, pi) => {
        const parts = para.split(/(\[\d+\])/g);
        return (
          <p key={pi} className="font-serif text-[1.05rem] leading-[1.75] text-ink">
            {parts.map((part, i) => {
              const m = part.match(/^\[(\d+)\]$/);
              if (m) {
                const n = parseInt(m[1], 10);
                return (
                  <FootnoteMarker
                    key={i}
                    n={n}
                    source={bySn.get(n)}
                    onJump={onJump}
                  />
                );
              }
              return <span key={i}>{part}</span>;
            })}
          </p>
        );
      })}
    </div>
  );
}

function SourceList({
  sources,
  scopeId,
  highlighted,
}: {
  sources: Source[];
  scopeId: string;
  highlighted: string | null;
}) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-6 border-t border-line pt-4">
      <p className="mb-3 font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ink-faint">
        Sources consulted
      </p>
      <ol className="list-none space-y-3">
        {sources.map((s) => {
          const id = `source-${scopeId}-${s.n}`;
          const isHighlighted = highlighted === id;
          return (
            <li
              key={s.n}
              id={id}
              className={`flex gap-3 rounded-sm px-2 py-1.5 -mx-2 transition-colors duration-700 ${
                isHighlighted ? "bg-gold-soft/40" : "bg-transparent"
              }`}
            >
              <span className="font-mono text-xs text-gold pt-0.5">[{s.n}]</span>
              <div className="min-w-0">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-serif text-sm text-ink underline decoration-line underline-offset-2 hover:decoration-gold"
                >
                  {s.title}
                </a>
                <p className="mt-0.5 font-sans text-xs text-ink-soft">
                  {s.authors.join(", ")} · {formatDate(s.date)}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const COVERAGE_LABEL: Record<BriefingSection["coverage"], string> = {
  sufficient: "Covered",
  widened: "Widened search",
  thin: "Limited coverage",
};

const COVERAGE_CLASS: Record<BriefingSection["coverage"], string> = {
  sufficient: "text-ink-faint",
  widened: "text-gold",
  thin: "text-wine",
};

export default function Home() {
  const [mode, setMode] = useState<Mode>("ask");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [briefingResult, setBriefingResult] = useState<BriefingResult | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const highlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setInput("");
    setError(null);
    setAskResult(null);
    setBriefingResult(null);
  }

  function scrollAndHighlight(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (highlightTimeout.current) clearTimeout(highlightTimeout.current);
    setHighlighted(id);
    highlightTimeout.current = setTimeout(() => setHighlighted(null), 1600);
  }

  // Both modes now use one consistent, globally-numbered source list per
  // result, so a footnote's own number maps directly to a list id.
  function jumpToSource(source: Source) {
    if (mode === "ask") {
      scrollAndHighlight(`source-ask-${source.n}`);
    } else {
      scrollAndHighlight(`allsource-${source.n}`);
    }
  }

  // Reads a fetch response as JSON, but doesn't assume it succeeded in
  // returning JSON at all. A serverless function that times out or crashes
  // at the platform level (not inside our own try/catch) returns an HTML or
  // plain-text error page instead — calling res.json() on that throws a
  // confusing "Unexpected token... is not valid JSON" instead of a real
  // error message. This surfaces a clear message for that case instead.
  async function parseJsonResponse(res: Response): Promise<Record<string, unknown>> {
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = (await res.text()).slice(0, 200);
      if (res.status === 504 || /timed?\s*out/i.test(text)) {
        throw new Error(
          "That request took too long and timed out — briefing mode runs several AI calls in sequence, so a broad topic can occasionally hit the time limit. Try a narrower topic, or try again."
        );
      }
      throw new Error(
        `The server returned an unexpected response (status ${res.status}) instead of a result. Please try again.`
      );
    }
    return res.json();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAskResult(null);
    setBriefingResult(null);
    try {
      if (mode === "ask") {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: input.trim() }),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error((data.error as string) || "Something went wrong.");
        setAskResult(data as unknown as AskResult);
      } else {
        const res = await fetch("/api/briefing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: input.trim() }),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error((data.error as string) || "Something went wrong.");
        setBriefingResult(data as unknown as BriefingResult);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <div className="font-mono text-xs uppercase tracking-[0.14em] text-ink-soft">
            CIGI Research Brief{" "}
            <span className="text-ink-faint">· independent demo</span>
          </div>
          <div className="flex rounded-sm border border-line bg-paper-raised p-0.5">
            <button
              type="button"
              onClick={() => switchMode("ask")}
              className={`px-3 py-1 font-mono text-xs uppercase tracking-wide transition-colors ${
                mode === "ask"
                  ? "bg-ink text-paper"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              Ask
            </button>
            <button
              type="button"
              onClick={() => switchMode("briefing")}
              className={`px-3 py-1 font-mono text-xs uppercase tracking-wide transition-colors ${
                mode === "briefing"
                  ? "bg-ink text-paper"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              Briefing
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        <p className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ink-faint">
          Research assistant
        </p>
        <h1 className="mt-2 font-serif text-[2rem] italic leading-tight text-ink sm:text-[2.35rem]">
          {mode === "ask"
            ? "Ask a question about CIGI's public research."
            : "Request a briefing on a topic in CIGI's public research."}
        </h1>
        <p className="mt-3 max-w-xl font-sans text-sm leading-relaxed text-ink-soft">
          Answers are drawn only from 40 real CIGI articles and policy briefs
          on artificial intelligence, data governance and digital governance,
          published between August 2025 and July 2026. Every claim is
          expected to trace back to a numbered source below it — if the
          research here doesn&apos;t cover something, it says so instead of
          guessing.
        </p>
        <div className="mt-4 border-l-2 border-wine bg-paper-raised px-4 py-3">
          <p className="font-sans text-xs leading-relaxed text-ink-soft">
            Independent demo built using CIGI&apos;s public research. Not an
            official CIGI product or an affiliated tool.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8">
          <label
            htmlFor="query"
            className="mb-2 block font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ink-faint"
          >
            {mode === "ask" ? "Ask a question" : "Briefing topic"}
          </label>
          <textarea
            id="query"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            placeholder={
              mode === "ask"
                ? "e.g. What does CIGI research say about AI export controls?"
                : "e.g. AI governance in Africa"
            }
            className="w-full resize-none rounded-sm border border-line bg-paper-raised px-4 py-3 font-serif text-base text-ink placeholder:text-ink-faint focus:border-ink"
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="rounded-sm bg-ink px-4 py-2 font-mono text-xs uppercase tracking-wide text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {loading
                ? "Researching…"
                : mode === "ask"
                ? "Ask"
                : "Build briefing"}
            </button>
            {loading && (
              <span className="font-mono text-xs text-ink-faint">
                Retrieving sources
                <span className="animate-cursor-blink">▊</span>
              </span>
            )}
          </div>
        </form>

        {error && (
          <div className="mt-6 border-l-2 border-wine bg-paper-raised px-4 py-3 animate-fade-in-up">
            <p className="font-sans text-sm text-wine">{error}</p>
          </div>
        )}

        {askResult && (
          <div className="mt-10 animate-fade-in-up">
            <FootnoteText
              text={askResult.answer}
              sources={askResult.sources}
              onJump={jumpToSource}
            />
            <SourceList
              sources={askResult.sources}
              scopeId="ask"
              highlighted={highlighted}
            />
          </div>
        )}

        {briefingResult && (
          <div className="mt-10 animate-fade-in-up">
            <h2 className="font-serif text-xl text-ink">
              {briefingResult.topic}
            </h2>
            <p className="mt-3 font-serif text-[1.05rem] leading-[1.75] text-ink-soft italic">
              {briefingResult.intro}
            </p>

            <div className="mt-8 space-y-10">
              {briefingResult.sections.map((section, i) => (
                <div key={i}>
                  <div className="flex items-baseline justify-between gap-4 border-b border-line pb-1.5">
                    <h3 className="font-serif text-lg text-ink">
                      <span className="font-mono text-sm text-gold mr-2">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {section.subQuestion}
                    </h3>
                    <span
                      className={`shrink-0 font-mono text-[0.65rem] uppercase tracking-wide ${COVERAGE_CLASS[section.coverage]}`}
                    >
                      {COVERAGE_LABEL[section.coverage]}
                    </span>
                  </div>
                  <div className="mt-3">
                    <FootnoteText
                      text={section.finding}
                      sources={section.sourcesUsed}
                      onJump={jumpToSource}
                    />
                  </div>
                </div>
              ))}
            </div>

            {briefingResult.allSources.length > 0 && (
              <div className="mt-10 border-t border-line pt-5">
                <p className="mb-3 font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ink-faint">
                  All sources referenced in this briefing
                </p>
                <ul className="list-none space-y-2">
                  {briefingResult.allSources.map((s) => {
                    const id = `allsource-${s.n}`;
                    const isHighlighted = highlighted === id;
                    return (
                      <li
                        key={s.n}
                        id={id}
                        className={`flex gap-3 rounded-sm px-2 py-1 -mx-2 font-sans text-sm text-ink-soft transition-colors duration-700 ${
                          isHighlighted ? "bg-gold-soft/40" : "bg-transparent"
                        }`}
                      >
                        <span className="font-mono text-xs text-gold pt-0.5">[{s.n}]</span>
                        <span>
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-ink underline decoration-line underline-offset-2 hover:decoration-gold"
                          >
                            {s.title}
                          </a>{" "}
                          — {s.authors.join(", ")}, {formatDate(s.date)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="border-t border-line px-6 py-6">
        <p className="mx-auto max-w-3xl font-mono text-[0.65rem] text-ink-faint">
          Built by Jordi Hako as an independent technical demo. Source
          content © CIGI, used here for research and citation-accuracy
          demonstration purposes only.
        </p>
      </footer>
    </div>
  );
}
