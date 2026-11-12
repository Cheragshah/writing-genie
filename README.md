# Writing Genie

**A writing assistant that checks AI-style patterns and public-source overlap, then rewrites the weak spots and exports a properly formatted DOCX or PDF.**

![Writing Genie home screen](docs/screenshot-home.png)

Upload a Word document, PDF, or plain text. Writing Genie gives you:

- **AI-style likelihood** with an explainable signal breakdown and a sentence-level heatmap
- **Source overlap** against Wikipedia, OpenAlex academic abstracts, famous quotations and repeated passages in the document
- **One-click clean-up** that rewrites stock phrasing, varies rhythm, paraphrases matched passages and re-scores the result
- **Formatted downloads** that rebuild the title, subtitle, Heading 1–3, bullets and quotations in Word or PDF

![Writing Genie report](docs/screenshot-report.png)

> Writing Genie is a writing assistant, not an academic-integrity authority. AI detectors disagree and produce false positives. Use the scores as a second opinion, and always review the final draft.

---

## Quick start

```bash
git clone https://github.com/Cheragshah/writing-genie.git
cd writing-genie
npm install
npm start
```

Open **http://localhost:4173**.

Requirements: **Node.js 26+** (the runtime Vercel currently uses). There are no API keys and no native binaries to install — PDF extraction uses the pure-JavaScript `unpdf` package.

On macOS you can also double-click `start.command`.

---

## Deploy on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Cheragshah/writing-genie)

The project is ready for Vercel's serverless runtime:

1. Push the project to GitHub (the repository is at [Cheragshah/writing-genie](https://github.com/Cheragshah/writing-genie)).
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
3. Create a Vercel Blob store and connect it to the project:
   ```bash
   npx vercel storage create writing-genie-uploads --type blob --access private
   npx vercel storage connect writing-genie-uploads --yes
   npx vercel storage update writing-genie-uploads --auth oidc --add-rw-token --yes
   ```
4. Deploy. The Blob connection supplies `BLOB_READ_WRITE_TOKEN`, which lets files over 4 MB upload directly from the browser and bypass the serverless request body limit.
5. Leave the framework preset as **Express** (Vercel detects it) and the build command empty.

`vercel.json` routes every request through the Express app in `api/index.js` and sets a 60-second function duration. Vercel sets `VERCEL=1` automatically; the app then switches to synchronous chunked processing because serverless instances cannot keep background jobs alive.

### Publish to GitHub

The repository is already live at **https://github.com/Cheragshah/writing-genie**. To publish future changes:

```bash
cd writing-genie
git add .
git commit -m "Describe your change"
git push
```

### Hosted vs local limits

| | Local | Vercel |
|---|---|---|
| Document size | 1,000,000 chars | 1,000,000 chars |
| Upload size | 12 MB | 25 MB via Vercel Blob |
| Long documents | Background jobs with live per-part progress | Synchronous chunked processing |
| PDF extraction | Pure JS (`unpdf`) | Pure JS (`unpdf`) |

The hosted limits keep requests inside Vercel's serverless body and duration limits.

---

## How it works

### AI-style analysis

An explainable heuristic combines ten weighted signals:

- density of AI-favoured phrases (“delve into”, “in today's fast-paced world”, …)
- sentence-length variance (burstiness) and the share of 14–26-word sentences
- formal transition openers (“However,” “Moreover,” …)
- contraction rate, em-dash frequency and rule-of-three patterns
- repeated sentence openers, paragraph symmetry and surface polish
- vocabulary range

Every sentence gets its own estimate and a short explanation.

### Source overlap

The longest, most varied sentences in the document are compared against:

- **Wikipedia** search results and full page extracts
- **OpenAlex** academic abstracts (full-text search, abstract reconstructed from the inverted index)
- a curated library of well-known quotations
- near-duplicate sentences inside your own document

Matching uses the longest common word run (minimum 8 words). The score is the share of document words inside matched spans. This is a **public-reference scan**, not a complete web index.

### Large documents

Documents over 60,000 characters are split on sentence boundaries into ~60,000-character parts:

1. Each part gets its own AI-style pass and offline quotation/repetition scan.
2. A spread sample of sentences from the whole document is checked against Wikipedia and OpenAlex.
3. Scores, signals, phrases, matches and sentence highlights are merged into one report.
4. Clean-up rewrites each part, rejoins the text, then re-analyses the whole cleaned document.

Locally this runs as an in-memory job queue with per-part progress. On Vercel it runs synchronously inside one request.

### Formatting and exports

Structure is read from DOCX heading styles where available (Title, Subtitle, Heading 1–6, lists, block quotes). For PDFs, positioned text items are regrouped into lines and paragraphs; headings are inferred from font size and typography. For plain text, the app uses Markdown headings, numbered sections, all-caps lines and short title-case lines.

When the cleaned text still has the same paragraph count, the original block types are reused; otherwise the structure is re-detected from the cleaned text.

Downloads:

- **DOCX** — real Word heading styles, title/subtitle, bullets, quotes and a footer
- **PDF** — matching typography, page layout and page numbers
- **TXT** — plain text fallback

---

## Project layout

```text
app.js                  Express app (routes, chunking, merging, jobs)
dev-server.js           Local listener
vercel.json             Vercel function settings

lib/ai-detector.js      Explainable AI-style scoring
lib/plagiarism.js       Wikipedia / OpenAlex / quotation / repetition scan
lib/humanizer.js        Rule-based rewrite engine
lib/structure.js        Title/heading inference and DOCX HTML parsing
lib/export.js           Styled DOCX and PDF generation
lib/file-extract.js     DOCX, PDF and text extraction
lib/text-utils.js       Sentence segmentation, offsets, readability

public/                 Front end (no build step)
```

## API

```text
GET  /api/config                 Deployment limits and mode
POST /api/extract                Multipart file upload → text + structure
POST /api/blob/upload            Vercel Blob client-upload token
POST /api/extract-blob           Download a Blob, extract text, delete the Blob
POST /api/analyze                Analyze text (chunks automatically when needed)
POST /api/humanize               Clean text and re-analyze
POST /api/export/docx            Formatted Word download
POST /api/export/pdf             Formatted PDF download

POST /api/jobs/analyze           Local only: background job
POST /api/jobs/humanize          Local only: background job
GET  /api/jobs/:id               Local only: progress / result
```

## Tests

```bash
npm test
```

This runs syntax checks across the server and library modules.

## Honest limits

- AI detectors disagree with each other and produce false positives. Writing Genie estimates style; it cannot guarantee any particular detector result.
- The reference scan covers public sources only; a full web index needs a commercial plagiarism API.
- Hosted uploads over 4 MB use Vercel Blob, so the deployment needs a connected Blob store. Without one, the hosted limit falls back to 4 MB.
- Public APIs occasionally rate-limit. The app falls back to the offline quotation/repetition scan.
- Direct quotations are intentionally preserved during clean-up. Cite them.
- Complex layouts (multiple columns, tables, images, custom fonts) are not reproduced in the formatted exports.
- PDFKit uses standard fonts, so the PDF export is best for Latin-script documents.

## License

MIT — see [LICENSE](LICENSE).
