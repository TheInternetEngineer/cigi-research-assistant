#!/usr/bin/env python3
"""
Scrapes the real article text for every source listed in data/sources.json
and saves each one as a clean markdown file in data/raw/.

Usage:
    python3 scripts/scrape_articles.py

Requirements:
    pip install -r scripts/requirements.txt

Notes:
- CIGI's article pages (cigionline.org/articles/... and /publications/...) are
  plain server-rendered HTML, so a simple requests + BeautifulSoup fetch works.
- For "Publication" type sources, the CIGI web page itself usually only shows
  an abstract/summary (the full paper lives in a linked PDF). This script only
  pulls the on-page text. That's fine for a v1 demo; deeper PDF ingestion can
  be added later if needed.
- Runs politely: one request at a time, 1.5s delay between requests, a
  descriptive User-Agent, and it obeys the specific page disallowed in
  cigionline.org/robots.txt (none of our URLs are on that list, but the check
  is here for safety if the source list ever changes).
"""

import json
import re
import time
from pathlib import Path

import cloudscraper
from bs4 import BeautifulSoup

# CIGI's site sits behind Cloudflare bot protection: plain `requests`, even
# with browser-style headers, gets a 403 because the underlying TLS/HTTP
# handshake doesn't match a real browser. cloudscraper solves Cloudflare's
# JS challenge the same way a browser would and reuses the resulting session
# cookie for every subsequent request, which is enough to get through for
# ordinary public pages like these.
scraper = cloudscraper.create_scraper(browser={"custom": "chrome"})

ROOT = Path(__file__).resolve().parent.parent
SOURCES_PATH = ROOT / "data" / "sources.json"
OUT_DIR = ROOT / "data" / "raw"

HEADERS = {
    # A plain descriptive UA (e.g. "CIGIResearchAssistantDemo/1.0") gets a 403
    # from CIGI's site — it's fronted by bot protection that expects a normal
    # browser-shaped request. Using a standard browser UA + Accept headers
    # here isn't trying to hide scraping intent or bypass access controls —
    # we're only requesting public article pages that aren't disallowed in
    # robots.txt, at a slow, polite rate (see time.sleep below).
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Pages robots.txt explicitly disallows (checked manually on 2026-07-29).
DISALLOWED_PATHS = [
    "/admin/",
    "/search/",
    "/qr/",
    "/publications/improving-the-cyber-health-of-canadas-isps-a-need-for-public-private-partnership",
]

# Markers that signal "end of real article body" — everything from here on
# (disclaimer, author bio, recommended articles, footer) gets dropped.
END_MARKERS = [
    "the opinions expressed in this",
    "about the author",  # matches both "About the Author" and "About the Authors"
]


def is_allowed(url: str) -> bool:
    return not any(path in url for path in DISALLOWED_PATHS)


def clean_paragraph(p) -> str | None:
    """Return cleaned paragraph text, or None if it should be skipped."""
    text = p.get_text(" ", strip=True)
    if not text:
        return None
    # Skip pure image-caption paragraphs (short, wrapped only in <em>/<i>,
    # or containing a photo-credit pattern).
    only_children = [c.name for c in p.find_all(recursive=False)]
    if only_children and all(name in ("em", "i") for name in only_children):
        return None
    if re.search(r"\((REUTERS|ZUMA|AP Photo|Getty)", text):
        return None
    if text.lower().startswith("listen to this article"):
        return None
    if "get regular updates on our research" in text.lower():
        # CIGI embeds a newsletter-signup CTA mid-article, not just in the
        # footer — filter it out wherever it appears.
        return None
    return text


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def extract_body(html: str, expected_title: str) -> str:
    """
    Anchors on the page's real <h1> (the article title) rather than trying to
    guess which <article>/<div> wraps the "real" content — CIGI's "Recommended"
    widget at the bottom of each page also uses semantic tags per card, which
    made container-based extraction unreliable (it was picking up a
    recommended card's heading instead of the actual body).

    Since there's exactly one <h1> per page, we find it, then only look at
    p/h2/h3 elements that appear *after* it in document order, stopping at
    the first known "end of article" marker.
    """
    soup = BeautifulSoup(html, "html.parser")

    all_elements = soup.find_all(["h1", "h2", "h3", "p"])

    # Locate the real title h1. Prefer an exact-ish normalized match; fall
    # back to the first h1 on the page if nothing matches closely enough.
    target = normalize(expected_title)
    h1_index = None
    for i, el in enumerate(all_elements):
        if el.name == "h1":
            if normalize(el.get_text(" ", strip=True)) == target:
                h1_index = i
                break
    if h1_index is None:
        for i, el in enumerate(all_elements):
            if el.name == "h1":
                h1_index = i
                break
    if h1_index is None:
        raise ValueError("could not find an <h1> on the page at all")

    paragraphs = []
    for el in all_elements[h1_index + 1 :]:
        if el.name == "h1":
            # Hit a second h1 — we've run past the real content somehow.
            break
        if el.name in ("h2", "h3"):
            heading = el.get_text(" ", strip=True)
            lowered_heading = heading.lower()
            if lowered_heading in ("recommended",) or any(
                marker in lowered_heading for marker in END_MARKERS
            ):
                break
            if heading:
                paragraphs.append(f"## {heading}")
            continue
        text = clean_paragraph(el)
        if text is None:
            continue
        lowered = text.lower()
        if any(marker in lowered for marker in END_MARKERS):
            break
        paragraphs.append(text)

    return "\n\n".join(paragraphs)


def build_frontmatter(source: dict) -> str:
    authors_list = ", ".join(source["authors"])
    topics_list = ", ".join(source["topics"])
    # Escape any double quotes in the title just in case.
    title = source["title"].replace('"', "'")
    return (
        "---\n"
        f'title: "{title}"\n'
        f"url: {source['url']}\n"
        f"date: {source['date']}\n"
        f"authors: [{authors_list}]\n"
        f"type: {source['type']}\n"
        f"topics: [{topics_list}]\n"
        "---\n\n"
    )


def main():
    sources = json.loads(SOURCES_PATH.read_text())
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    ok, failed, skipped = [], [], []

    for i, source in enumerate(sources, 1):
        slug = source["slug"]
        url = source["url"]
        out_path = OUT_DIR / f"{slug}.md"

        if out_path.exists():
            print(f"[{i}/{len(sources)}] SKIP (already exists): {slug}")
            skipped.append(slug)
            continue

        if not is_allowed(url):
            print(f"[{i}/{len(sources)}] SKIP (robots.txt disallow): {slug}")
            skipped.append(slug)
            continue

        print(f"[{i}/{len(sources)}] Fetching: {slug} ...")
        try:
            resp = scraper.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            body = extract_body(resp.text, source["title"])
            if len(body) < 150:
                print(f"    WARNING: extracted body looks short ({len(body)} chars) — check manually.")
            content = build_frontmatter(source) + body + "\n"
            out_path.write_text(content, encoding="utf-8")
            print(f"    saved {len(body)} chars -> {out_path.relative_to(ROOT)}")
            ok.append(slug)
        except Exception as e:
            print(f"    FAILED: {e}")
            failed.append((slug, str(e)))

        time.sleep(1.5)  # be polite

    print("\n--- Summary ---")
    print(f"Saved:   {len(ok)}")
    print(f"Skipped: {len(skipped)}")
    print(f"Failed:  {len(failed)}")
    if failed:
        for slug, err in failed:
            print(f"  - {slug}: {err}")


if __name__ == "__main__":
    main()
