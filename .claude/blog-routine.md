# Datreon Auto-Blog Routine — Playbook

You are running the scheduled Datreon blog routine. Produce **one** new, on-brand blog post with visuals, wire it into the site, and push it to a **branch for review** (do NOT publish to `main`). Work in the repo at the current working directory (the Datreon static site).

## 0. Guardrails (read first)
- **Review gate:** never push to `main` and never deploy. Push to a new branch only; a human merges to publish.
- **Voice:** direct, credible, concrete. Never use the word "senior" in brand copy. Tie to "One Team. Total Ownership." only where it's natural. No clickbait, no hype, no invented statistics or fake client names/quotes. Illustrative examples must read as illustrative.
- **Visuals are mandatory** (owner preference): every post includes at least **one inline SVG diagram** AND at least **one HTML table**. No external images or scripts (CSP-safe).

## 1. Pick the topic
- Read `.claude/blog-queue.json`. Choose the **first** item with `"status": "pending"`.
- If none are pending, stop and report: "Blog queue is empty — add topics to .claude/blog-queue.json." Do not invent a topic.
- Note its `slug`, `title`, `category`, `angle`, `visual`.

## 2. Branch
- Determine today's date (YYYY-MM-DD).
- `git checkout main && git pull --ff-only origin main`
- `git checkout -b blog/auto-<YYYY-MM-DD>-<slug>`

## 3. Write the post → `blog/<slug>.html`
- **Copy the structure of an existing post exactly**: open `blog/ai-pilots-that-ship.html` and use it as the template. Keep the same `<head>` (fonts, `/css/style.css?v=29`, favicon), `legal-nav` header, and `footer`. Use **root-absolute paths** (`/assets/...`, `/css/...`) because the file is in the `blog/` subdirectory.
- Update per-post: `<title>`, meta description, canonical (`https://datreon.tech/blog/<slug>`), all OG/Twitter tags, `article:published_time` (today), and the **BlogPosting JSON-LD** (`headline`, `description`, `datePublished`/`dateModified` = today, `url`).
- Body structure (reuse these exact classes):
  - `<p class="eyebrow">` = the item's `category`.
  - `<h1 class="legal__title">` = the title (may shorten slightly for the H1).
  - `<div class="post__meta">` with `Datreon · <Month D, YYYY> · <N> min read`.
  - `<p class="legal__lead">` = a strong 2–3 sentence hook.
  - `<div class="legal__body">` = the article: ~900–1,100 words, 4–6 `<h2>` sections, short paragraphs, `<ul>` lists, and one `<blockquote>` if a strong pull-quote fits.
  - End with the `<div class="post__cta">` block (heading + one sentence + `<a href="/#contact" class="btn btn--fill btn--lg">Start a Conversation</a>`) and the `<a href="/blog" class="post__back">` link. Copy these from the template and adjust the CTA copy to the topic.

## 4. The visuals (mandatory)
Follow the item's `visual` idea. Use the site palette and put each diagram in a `<figure class="post__figure">` with a `<figcaption class="post__fig-cap">`, and each table in `<div class="table-wrap"><table>…`.
- **Palette:** ink text `#111111`; secondary/gray `#686868`; the ONE accent is gold `#F5C53A` (use it to highlight the "good"/target element); hairline strokes `stroke="#111111" stroke-opacity="0.3"`.
- **SVG rules:** include `viewBox`, `role="img"`, and `<title>`/`<desc>` for a11y; `font-family="'JetBrains Mono', ui-monospace, monospace"` on labels; keep it to clean rects/lines/circles/text (no external refs). The CSS already sizes it (`.post__figure svg { width:100%; height:auto }`), so design at a fixed viewBox (~700–720 wide) and let it scale. Balance every tag.
- **Table:** use `<thead>`/`<tbody>`; first column is the row label. Styling is already in the design system (`.legal__body table`).

## 5. Wire it into the site
- **`blog.html` (index):** add a new `<a class="post-card" href="/blog/<slug>">…` card at the **top** of `.post-list` (newest first), with `post-card__meta` (category · date · read time), `post-card__title`, `post-card__excerpt` (~2 sentences), and the `post-card__more` "Read the post →" span. Also add the post to the `"blogPost"` array in the page's Blog JSON-LD.
- **`sitemap.xml`:** add a `<url>` for `https://datreon.tech/blog/<slug>` (lastmod = today, changefreq monthly, priority 0.7), placed with the other blog posts.
- **CSS cache-bust:** do NOT change it. Reuse `css/style.css?v=29`. Only bump the `?v=` (in all HTML files) if you actually edit `css/style.css` — normally you won't.

## 6. Mark the topic done
- In `.claude/blog-queue.json`, set the chosen item's `"status"` to `"published"` and add `"published_date": "<YYYY-MM-DD>"`.

## 7. Self-check before committing
- [ ] Valid HTML; SVG tags balanced; no external assets except Google Fonts.
- [ ] Root-absolute `/assets` and `/css` paths in the post.
- [ ] Unique title, meta description, canonical, and BlogPosting JSON-LD.
- [ ] At least one SVG figure **and** one table present.
- [ ] Word "senior" absent; no fabricated stats/clients; voice on-brand.
- [ ] Index card + sitemap entry + queue status all updated.

## 8. Commit, push branch, report (NO deploy)
- `git add -A`
- Commit: `Blog (auto): <title>` with a one-line body and the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
- `git push -u origin blog/auto-<YYYY-MM-DD>-<slug>`
- If `gh` is authenticated, open a PR to `main` titled the post title; otherwise report the branch name and the GitHub compare URL: `https://github.com/priyankpatel22/datreon/compare/main...blog/auto-<YYYY-MM-DD>-<slug>?expand=1`.
- **Report back**: post title, slug, review/PR link, and a one-line note that merging the branch publishes it (Cloudflare builds a preview for the branch first).

Do not merge. Do not push to main. Stop after reporting.
