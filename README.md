# Book Reader: PDF → EPUB converter, and a reader for PDF and EPUB

Turns PDF books and articles into **EPUB 3** files that any e-book app can reflow, such as Google Play Books, ReadEra, Moon+ Reader, Kindle (via Send to Kindle), Calibre and Thorium.
It is also a reader in its own right for **PDF and EPUB** books: a library, adjustable fonts, progress tracking, and notes that go to Google Keep or Obsidian.

Everything runs **on your device and offline**: no server, no cloud, no AI tokens.

| Where | How |
|---|---|
| Android | Installable web app (PWA). You can also share a PDF or EPUB from any app to "Book Reader". |
| Windows | The same PWA installed from Edge or Chrome ("Open with → Book Reader" works for `.pdf` and `.epub` files), **plus** a command-line batch converter. |

---

## Features by priority

### P1: done and tested
1. **PDF → EPUB 3.** Use the "PDF → EPUB" button in the app or `tools/pdf2epub.mjs`. The output passes the official epubcheck 5.2.1 validator with 0 errors and 0 warnings, including on a 402-page technical book.
   - **Text:** rebuilds paragraphs from the PDF's lines, joins hyphenated words and keeps bold, italic and `inline code`. Bullet lists stay lists.
   - **Chapters:** chapters and table of contents come from the PDF bookmarks, or from detected headings when there are none. Heading levels follow the bookmarks, and there is one XHTML file per chapter.
   - **Printed page numbers:** pages carry the book's own numbering (i, ii … xxvi, 1, 2 …), taken from the PDF's page labels or read from its headers and footers. EPUB readers can show "page 53", and citations still match.
   - **The book's own contents pages:** each line becomes a link to its chapter, with the page number right-aligned. Index pages stay one entry per line, with sub-entries indented.
   - **Code listings** (monospace fonts) keep their line breaks, indentation and columns. Wide listings get a smaller font in the EPUB.
   - **Note / Warning / Tip boxes** become marked boxes.
   - **Pictures:** cut from the page as JPEG, including vector diagrams with their labels. Text that wraps around a picture is kept out of the image. **Captions** ("Figure 2-1", "Listing 3-4", "Table 1-1") become `<figcaption>`.
   - **Tables** become real tables: merged cells, header rows, ruled rows, and journal-style tables with only horizontal rules. Rule-framed code and box-and-arrow diagrams are recognised and not mistaken for tables.
   - **Letter-spaced titles** ("C O N T E N T S") are repaired using the same words found elsewhere in the book.
   - **Running headers/footers** ("Chapter 1", "A Visit to the Dark Web 3") and page numbers are removed from the text.
   - **Two-column layouts** are read column by column.
   - Cover image, title, author and language. **Hebrew and Arabic** get right-to-left text, tables and page order.
2. **Read EPUB files directly** (EPUB 2 and 3). The app reads them on the device and shows them with the same reader as PDFs.
   - Works with your fonts, themes, progress tracking, notes and contents panel.
   - Keeps chapters from the book's own contents, plus headings, lists, quotations, code, tables, pictures (SVG too), note boxes and links between chapters.
   - Shows the book's printed page numbers when the EPUB has a page list (EPUBs made by this app do). Otherwise the reader shows % only.
   - Copy-protected (DRM) books are refused with a clear message: they can only be opened in the app they were bought for.
3. **Library** stored on the device. It skips duplicates and asks the browser not to delete it when storage is low.
4. **Reader**
   - Reflowed text with font, size, line spacing, width and theme controls (Light, Sepia, Dark, Black).
   - The original page view is one tap away.
   - Contents panel.
   - It tracks **where you are** (chapter, page) and **what you've actually read**, per chapter, with bookmarks and a way back after jumps. See [Reading progress](#reading-progress).
5. **Notes from selected text**
   - On Android, the share sheet sends them to Google Keep.
   - On Windows, the note is copied and keep.new opens.
   - You can also append to an Obsidian note per book, copy as Markdown, or export all notes as `.md`. Notes are highlighted in the text.
6. **App integration**
   - Install it as an app, and it works offline.
   - Windows file association.
   - Android "share to app".
   - Drag and drop on the desktop.

### P2: next
- Footnotes → EPUB pop-up notes.
- Equations kept as images.
- Tables without any lines, detected from text alignment.
- Optional "fixed layout" EPUB for comics and magazines.
- Sync the library between phone and PC through a Google Drive or OneDrive folder.
- Store packages through PWABuilder: an Android package for Google Play and an MSIX for the Microsoft Store.

### P3: later
Text-to-speech, full-text search, coloured highlights, dictionary lookup.

---

## Use it

### 1. Run or host the app
It is a static site, so any web host works. HTTPS is needed to install it, except on `localhost`.

```bash
# try locally (PC)
npx serve .                 # or: python -m http.server 8080
# open http://localhost:8080
```

To make it available on your phone, use **GitHub Pages** (free):
1. Push this folder to a GitHub repo.
2. In the repo, open **Settings → Pages → Source: GitHub Actions**. The included workflow `.github/workflows/pages.yml` publishes every push to `main`.
3. Open the URL:
   - **Android (Chrome):** menu ⋮ → *Install app*.
   - **Windows (Edge or Chrome):** click the install icon in the address bar.

Netlify, Cloudflare Pages or an internal IIS or nginx server work the same way: upload `index.html manifest.webmanifest sw.js css js icons vendor`.

### 2. Convert
- **In the app:** tap **PDF → EPUB**, pick one or more PDFs, then **Download EPUB** (or **Share** it straight into a reader app). Books you've already added have a **⤓ EPUB** button.
- **Command line (Windows, batch):**
  ```powershell
  npm install
  node tools\pdf2epub.mjs "C:\Books\book.pdf"
  node tools\pdf2epub.mjs "C:\Books" -o "C:\Books\epub"     # every PDF in a folder
  node tools\pdf2epub.mjs scan.pdf --lang he                # force the language
  ```
  It needs Node 20 or newer. `@napi-rs/canvas` ships prebuilt Windows binaries, so no compiler is required.

On a phone, open the EPUB with ReadEra, Moon+ Reader, Lithium or Google Play Books (upload). On Windows, use Thorium Reader or Calibre, or Kindle through Send to Kindle, which accepts EPUB.

### Reader keys (Windows)
`T` contents · `N` notes · `B` bookmark · `G` go to page · `A` text settings · `E` export EPUB · `O` original pages · `+`/`-` text size · `←`/`→` page · `Esc` library.

---

## Reading progress

The app keeps two separate things for each book:

- **Where you are**: the paragraph at the top of the screen. The book reopens there, on any change of font or size.
- **What you've read**: each paragraph counts as read once it has been on screen about as long as a fast reader needs for it (≈350 words/min). Scrolling or jumping past text doesn't count; reading two paragraphs in the middle of a chapter marks just those two.

Common situations:

| You want to… | What to do |
|---|---|
| Read one chapter from the middle | ☰ Contents → tap it. A **↩ Back to p. X** chip appears; tap it to return (tap again to flip back). |
| See what's left | ☰ Contents: each chapter shows ○ not read, ◐ started (with % and time left), ✓ read. The status bar shows time left in the chapter and the book's % read. |
| Continue a chapter you left halfway | Tap the chapter: started chapters open where you stopped in them (⋯ → *Go to start* for the beginning). |
| Read only a few lines, then leave | Just those paragraphs are marked; the chapter shows as started. |
| You read a chapter elsewhere, or want to read it again | Chapter ⋯ → **Mark as read** / **Mark as unread** (also in the reader's ⋮ menu for the current chapter). |
| Read the book again | ⋮ → **Start over…** (or Library → ⋮). Progress clears; notes and bookmarks stay. |
| Keep several places | ⋮ → **Bookmark this place** (`B`); they're listed under ☰ → Bookmarks. |
| Follow a printed page reference | ⋮ → **Go to page…** (`G`) uses the book's own page numbers. |

The library card shows the share read, chapter and page, or *Finished* with the date. Time estimates use your own reading speed in that book, measured as you read. Re-processing a book after an app update keeps your place, what you read, bookmarks and notes.

---

## OCR (scanned PDFs)

Some PDFs are only pictures of pages (scans, or pages exported as images), so there is no text to reflow. The app and the command line now **read those pages with OCR on your device** and turn them into real text: headings, paragraphs, bullet lists, code listings, note boxes and tables. Covers and designed pages stay pictures.

- **Engine:** Tesseract 5 (tesseract.js 7, WebAssembly), vendored in `vendor/tesseract` with English and Hebrew "best" models. No AI tokens, no cloud; your books never leave the device.
- **Language:** *Automatic* reads the first page with real text and picks English, Hebrew or both. You can force it: Library → ⚙ → *Scanned / picture-only PDF pages*, or `--ocr eng|heb|eng+heb|off` on the command line.
- **First use:** about 7 MB (engine + language data) downloads once; the service worker keeps it for offline use.
- **Speed:** about 2–3 s per page on a PC, more on a phone. A converted book is saved, so it's a one-time cost.
- **Accuracy:** good on clean scans and exported pages. OCR can still misread single letters (`l`/`I`, `0`/`O`), especially in code. The import message says how many pages were read with OCR.

```powershell
node tools\pdf2epub.mjs scanned.pdf                 # OCR happens automatically when needed
node tools\pdf2epub.mjs scanned.pdf --ocr heb       # force Hebrew
```

For badly skewed or rotated scans, **OCRmyPDF** on the PC is still the strongest option (it straightens and rotates pages first). The converter uses the text layer it adds:

```powershell
pip install ocrmypdf     # needs Tesseract and Ghostscript (winget: UB-Mannheim.TesseractOCR, ArtifexSoftware.GhostScript)
ocrmypdf -l heb+eng --deskew --rotate-pages scanned.pdf scanned-ocr.pdf
```

---

## Tech stack, and why

- **Plain JavaScript (ES modules), no framework, no build step.**
  - Deploying means copying files, and every file can be read on its own.
  - It runs the same on Android and Windows, and wraps easily into store packages later (PWABuilder or Capacitor).
- **pdf.js 6.2** (Mozilla) is vendored in `vendor/pdfjs`, including its fonts, CJK maps and the JPEG 2000 and JBIG2 decoders used in scanned books, so nothing is loaded from a CDN.
- **Tesseract 5 (tesseract.js 7)** is vendored in `vendor/tesseract` for OCR of picture-only pages: LSTM-only WebAssembly builds and the English/Hebrew models. It loads only when a book needs it.
- **IndexedDB** stores books and notes. A **service worker** provides offline use, installation and the Android share target.
- The **EPUB writer and ZIP writer** are our own code and need no other libraries (zip uses the built-in `CompressionStream`). The same code runs in the browser and in Node.

```
index.html, manifest.webmanifest, sw.js      app shell, install, offline, share target
css/app.css                                  themes and layout (phone first)
js/app.js                                    routing, import, OS integrations
js/library.js, js/reader.js                  views
js/settings.js, js/ui.js, js/db.js           settings, DOM helpers, storage
js/pdf/analyze.js   text items → lines → fragments, column gutter, vector/image operators
js/pdf/regions.js   tables (ruled grids, horizontal-rule tables), pictures, vector figures
js/pdf/layout.js    reading order (columns), paragraphs, headings, RTL rules
js/pdf/extract.js   whole book: headers/footers, body size, image crops, TOC
js/epub/epub.js     book model → EPUB 3 (OPF, nav, NCX, page list, chapters)
js/epub/import.js   EPUB 2/3 → book model (reading EPUBs)    js/epub/load.js  browser glue
js/epub/zip.js, unzip.js   ZIP writer/reader       js/epub/export.js   app "Export EPUB"
js/ocr/raster.js    page picture analysis: shaded boxes, table lines, pictures, stroke weight
js/ocr/page.js      OCR words → the same fragments as a text PDF (code, bullets, bold, tables)
js/ocr/provider.js  Tesseract worker, language choice, second pass for missed lines
js/progress.js      reading progress: what's read (block ranges), chapters, speed, re-process remap
js/notes/*          notes and where they're sent (Keep, Obsidian, Markdown)
tools/pdf2epub.mjs  command-line converter    tools/node-ocr.mjs  OCR in Node
tools/vendor.mjs    copies pdf.js and Tesseract into vendor/ (npm run vendor)
tests/*             extraction, EPUB and end-to-end browser tests
samples/*           test PDFs (4-page book, LaTeX two-column paper, Hebrew, tech book, scanned copy)
```

### Extending
- **Another notes destination** (Notion, OneNote, email, your API): add an entry to `PROVIDERS` in `js/notes/providers.js`. It appears in Settings automatically.
- **Another input format** (DOCX, HTML, Markdown): produce the same *book model* (`{blocks, toc, pages}`, documented at the top of `js/pdf/extract.js`). The reader and the EPUB export then work unchanged.
- **Tuning the conversion:** all the heuristics are named constants in `analyze.js`, `regions.js` and `layout.js`. Add the problem PDF to `samples/` and an assertion to `tests/extract.test.mjs`.
- **Updating pdf.js or Tesseract:** change the version in `package.json`, then run `npm install && npm run vendor`, and bump `VERSION` in `sw.js`.

### Tests
```bash
npm install
npm test                                   # PDF extraction, OCR, EPUB export/import, reading progress (Node)
EPUBCHECK=path/to/epubcheck.jar npm test   # + official EPUB validator
python -m http.server 8080 &  python tests/e2e.py --shots shots/   # full browser test (Playwright)
```

### Known limits
- Complex magazine layouts (three or more columns, side notes) may read out of order. The original page view is always there.
- Footnotes currently stay where they are printed. Equations become plain text.
- Tables without any lines read as paragraphs.
- Books converted by an older version: use Library → ⋮ → **Re-process** to get the improvements.
