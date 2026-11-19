"""End-to-end test in a real Chromium (Playwright).

    python3 -m http.server 8080 &        # from the project root
    python3 tests/e2e.py [--shots DIR] [--url http://localhost:8080/]

Covers: import, reflow (headings/image/table/2 columns), settings, notes + highlight, resume position,
original-page view, service worker (offline), the Android share-target endpoint, reading EPUBs,
reading progress (chapters, bookmarks, back chip, start over) and OCR of a scanned PDF.
"""
import argparse
import os
import sys
import time

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--url', default='http://localhost:8080/')
ap.add_argument('--shots', default='')
ap.add_argument('--chrome', default=os.environ.get('CHROME', '/usr/bin/google-chrome'))
args = ap.parse_args()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE = os.path.join(ROOT, 'samples', 'sample-book.pdf')
failed = []
errors = []


def check(name, cond):
    print(('PASS ' if cond else 'FAIL ') + name)
    if not cond:
        failed.append(name)


def bars(page):
    # Scrolling down hides the bars (immersive reading); a tap brings them back.
    page.evaluate("document.body.classList.remove('immersive')")
    page.wait_for_timeout(250)


def shot(page, name):
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)
        page.screenshot(path=os.path.join(args.shots, name + '.png'))


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.chrome, args=['--no-sandbox'])
    phone = dict(viewport={'width': 412, 'height': 860}, device_scale_factor=2, is_mobile=True, has_touch=True,
                 user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36')
    ctx = browser.new_context(**phone)
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=args.url.rstrip('/'))
    page = ctx.new_page()
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.on('pageerror', lambda e: errors.append(str(e)))

    page.goto(args.url)
    page.wait_for_selector('.lib-bar')
    shot(page, '01-empty-library')

    # Import
    page.set_input_files('#pick-import', SAMPLE)
    page.wait_for_selector('.card', timeout=60000)
    check('book card appears', page.locator('.card').count() == 1)
    check('title from PDF metadata', page.locator('.card .title').inner_text() == 'The Pocket Guide to Reading Software')
    page.wait_for_timeout(300)
    shot(page, '02-library')

    # Open reader
    page.locator('.card .cover').click()
    page.wait_for_selector('.flow [data-b]')
    page.wait_for_timeout(500)
    check('chapter headings rendered', page.locator('.flow :is(h2,h3,h4)', has_text='Chapter').count() == 4)
    check('table rendered as HTML', page.locator('.flow table tr').count() == 5)
    check('table header row', page.locator('.flow table th').count() == 4)
    shot(page, '03-reader-top')

    page.locator('.flow figure.fig img').scroll_into_view_if_needed()
    page.wait_for_function("() => { const i = document.querySelector('.flow figure.fig img'); return i && i.complete && i.naturalWidth > 100; }", timeout=10000)
    check('figure image loaded', True)
    page.evaluate("document.querySelector('.flow figure.fig').scrollIntoView({block:'center'})")
    page.wait_for_timeout(400)
    shot(page, '04-reader-figure')

    page.evaluate("document.querySelector('.flow .tbl').scrollIntoView({block:'center'})")
    page.wait_for_timeout(300)
    shot(page, '05-reader-table')
    page.locator('.tbl .snap-btn').click()
    page.wait_for_function("() => { const i = document.querySelector('.tbl img.snap'); return i && i.complete && i.naturalWidth > 100; }", timeout=10000)
    check('table original snapshot', True)
    shot(page, '06-table-original')
    page.locator('.tbl .snap-btn').click()

    status = page.locator('.bar.bottom .status').inner_text()
    chapter = page.locator('.titles .sub').inner_text()
    check(f'status shows page ({status})', status.startswith('Page 3 '))
    check(f'chapter tracked ({chapter})', chapter.startswith('Chapter 3'))

    # TOC
    bars(page)
    page.get_by_label('Contents').click()
    page.wait_for_selector('.toc-item')
    check('toc has 4 chapters', page.locator('.toc-item').count() == 4)
    check('current chapter highlighted', 'Chapter 3' in page.locator('.toc-item.current').inner_text())
    shot(page, '07-toc')
    page.locator('.toc-item').nth(3).click()
    page.wait_for_timeout(500)
    check('jump to chapter 4', page.locator('.titles .sub').inner_text().startswith('Chapter 4'))
    text = page.evaluate("[...document.querySelectorAll('.flow p')].map(p => p.textContent).join('\\n')")
    check('two-column reading order', text.index('The left column ends here') < text.index('The right column starts here') < text.index('This is the last paragraph'))

    # Settings: font, size, theme
    bars(page)
    page.get_by_label('Text settings').click()
    page.get_by_role('button', name='Sans').click()
    for _ in range(3):
        page.get_by_label('Bigger').click()
    page.get_by_role('button', name='Sepia').click()
    shot(page, '08-settings')
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    size = page.evaluate("getComputedStyle(document.querySelector('.flow')).fontSize")
    font = page.evaluate("getComputedStyle(document.querySelector('.flow')).fontFamily")
    check(f'font size changed ({size})', size == '22px')
    check('font family changed', 'system-ui' in font)
    check('theme sepia', page.evaluate("document.documentElement.dataset.theme") == 'sepia')
    shot(page, '09-sepia-sans-22')

    # Note from a selection
    page.evaluate("""() => {
      const p = [...document.querySelectorAll('.flow p')].find(p => p.textContent.startsWith('Notes are saved together'));
      p.scrollIntoView({block: 'center'});
      const t = p.firstChild; const r = document.createRange();
      r.setStart(t, 0); r.setEnd(t, 'Notes are saved together with the chapter and page'.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }""")
    page.wait_for_selector('.selbar:not([hidden])')
    check('no "Add to note" before the first note', not page.locator('.selbar button', has_text='Add to note').is_visible())
    shot(page, '10-selection-bar')
    page.locator('.selbar button', has_text='New note').click()
    page.wait_for_selector('.sheet textarea')
    check('new note says it is not saved yet', 'Not saved yet' in page.locator('.save-state').inner_text())
    page.locator('.sheet textarea.comment').fill('Good point about locations.')
    page.wait_for_timeout(800)
    check(f'note saves as you type and says where ({page.locator(".save-state").inner_text()})', 'Saved in this book’s notes' in page.locator('.save-state').inner_text())
    page.locator('.sheet select').select_option('clipboard')
    shot(page, '11-note-editor')
    page.locator('.send-row button', has_text='Send').click()
    page.wait_for_timeout(400)
    clip = page.evaluate('navigator.clipboard.readText()')
    check('note sent as markdown', clip.startswith('> Notes are saved together with the chapter and page') and 'Chapter 4: Two-Column Articles · p. 4' in clip)
    check('editor shows where it was sent', 'Sent to Copy (Markdown)' in page.locator('.sheet').inner_text())
    # Google Keep on a computer: copied + the paste step explained
    page.locator('.sheet select').select_option('keep')
    page.locator('.send-row button', has_text='Send').click()
    page.wait_for_selector('.sheet >> text=Open Keep')
    clip = page.evaluate('navigator.clipboard.readText()')
    check('Keep: note copied, paste step explained', clip.startswith('“Notes are saved together') and page.locator('kbd').count() == 1)
    page.wait_for_timeout(400)
    shot(page, '11b-keep-paste')
    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    page.get_by_role('button', name='Done').click()
    page.wait_for_timeout(300)
    check('quote highlighted', page.locator('.flow mark.hl').count() == 1)
    # Add another quote to the last note
    page.evaluate("""() => {
      const p = [...document.querySelectorAll('.flow p')].find(p => p.textContent.includes('Reading on a phone'));
      p.scrollIntoView({block: 'center'});
      const t = p.firstChild; const r = document.createRange();
      r.setStart(t, 0); r.setEnd(t, 'Reading on a phone'.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }""")
    page.wait_for_selector('.selbar:not([hidden])')
    page.locator('.selbar button', has_text='Add to note').click()
    page.wait_for_selector('.sheet .clip')
    check('quote added to the last note', page.locator('.sheet .clip').count() == 2)
    page.wait_for_timeout(700)
    page.get_by_role('button', name='Done').click()
    page.wait_for_timeout(300)
    check('both quotes highlighted', page.locator('.flow mark.hl').count() == 2)
    bars(page)
    page.get_by_label('Notes').click()
    page.wait_for_selector('.note')
    check('note listed with its two quotes', page.locator('.note').count() == 1 and page.locator('.note blockquote').count() == 2)
    page.wait_for_timeout(400)
    shot(page, '12-notes')
    # A note without a quote
    page.get_by_role('button', name='＋ New note').click()
    page.wait_for_selector('.sheet textarea.comment')
    page.locator('.sheet textarea.comment').fill('Ask about EPUB on e-readers.')
    page.get_by_role('button', name='Done').click()
    page.wait_for_timeout(500)
    # The last note reopens the one just written
    page.keyboard.press('l')
    page.wait_for_selector('.sheet textarea.comment')
    check('"last note" opens the latest one', page.locator('.sheet textarea.comment').input_value() == 'Ask about EPUB on e-readers.')
    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    # Resume position after reload
    page.evaluate("document.querySelector('.flow .tbl').scrollIntoView({block:'start'})")
    page.wait_for_timeout(1300)  # throttle + debounced save
    top_block = "(() => { const y = document.querySelector('.bar.top').getBoundingClientRect().bottom + 9; const el = [...document.querySelectorAll('.flow [data-b]')].find(n => n.getBoundingClientRect().bottom > y); return +el.dataset.b; })()"
    before = page.evaluate(top_block)
    page.reload()
    page.wait_for_selector('.flow [data-b]')
    page.wait_for_timeout(800)
    after = page.evaluate(top_block)
    check(f'position restored after reload (block {before} -> {after})', before == after)
    check('resumed chapter', page.locator('.titles .sub').inner_text().startswith('Chapter 3'))

    # Original pages
    bars(page)
    page.get_by_label('Toggle original pages').click()
    page.wait_for_function("() => document.querySelectorAll('.page canvas').length >= 1", timeout=15000)
    page.wait_for_timeout(500)
    check('original page canvases render', page.locator('.page canvas').count() >= 1)
    shot(page, '13-original-page')
    bars(page)
    page.get_by_label('Toggle original pages').click()
    page.wait_for_timeout(300)

    # Back to library: progress shown
    bars(page)
    page.get_by_label('Back to library').click()
    page.wait_for_selector('.card')
    where = page.locator('.card .where').inner_text()
    check(f'library shows progress ({where})', 'p. 3' in where)
    when = page.locator('.card .when').inner_text()
    check(f'library card shows the notes, kept after reloads ({when})', '2 notes' in when)
    shot(page, '14-library-progress')

    # Export EPUB from the library card (phone)
    with page.expect_download() as dl:
        page.locator('.epub-btn').click()
        page.wait_for_selector('#epub-download', timeout=30000)
        shot(page, '14b-epub-ready')
        page.click('#epub-download')
    epub_path = os.path.join(args.shots or '/tmp', 'phone-export.epub')
    dl.value.save_as(epub_path)
    with open(epub_path, 'rb') as fh:
        head = fh.read(60)
    check('exported EPUB is a zip with mimetype first', head[:2] == b'PK' and b'mimetypeapplication/epub+zip' in head)
    if os.environ.get('EPUBCHECK'):
        import subprocess
        r = subprocess.run(['java', '-jar', os.environ['EPUBCHECK'], epub_path], capture_output=True, text=True)
        check('app EPUB passes epubcheck', r.returncode == 0 and '0 errors' in r.stdout + r.stderr)

    # Service worker + offline
    page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true)')
    page.reload()
    page.wait_for_function('!!navigator.serviceWorker.controller', timeout=10000)
    ctx.set_offline(True)
    page.reload()
    page.wait_for_selector('.card', timeout=10000)
    page.locator('.card .cover').click()
    page.wait_for_selector('.flow [data-b]')
    check('works offline', page.locator('.flow :is(h2,h3,h4)', has_text='Chapter').count() == 4)
    ctx.set_offline(False)

    # Share target (what Android does when you share a PDF to the app)
    page.goto(args.url)
    page.wait_for_selector('.card')
    with open(os.path.join(ROOT, 'samples', 'article-2col.pdf'), 'rb') as fh:
        pdf2 = list(fh.read())
    page.evaluate("""async (bytes) => {
      const fd = new FormData();
      fd.append('file', new File([new Uint8Array(bytes)], 'Shared Article.pdf', {type: 'application/pdf'}));
      const r = await fetch('./share-target', {method: 'POST', body: fd, redirect: 'manual'});
      return r.type;
    }""", pdf2)
    page.goto(args.url + '?shared=1#/inbox')  # Android opens the redirect target as a fresh page load
    page.wait_for_selector('.flow [data-b]', timeout=30000)
    check('shared PDF imported and opened', 'Shared' in page.locator('.titles .ttl').inner_text() or page.locator('.flow [data-b]').count() > 0)
    page.goto(args.url)
    page.wait_for_selector('.card')
    check('library has 2 books', page.locator('.card').count() == 2)

    # Desktop (Windows-size window)
    desk = browser.new_context(viewport={'width': 1366, 'height': 860})
    dp = desk.new_page()
    dp.goto(args.url)
    dp.wait_for_selector('.lib-bar')
    dp.set_input_files('#pick-convert', SAMPLE)
    # One-step PDF -> EPUB: the dialog offers the download
    dp.wait_for_selector('#epub-download', timeout=60000)
    shot(dp, '15-desktop-epub-ready')
    with dp.expect_download() as dl:
        dp.click('#epub-download')
    dl.value.save_as(os.path.join(args.shots or '/tmp', 'desktop-convert.epub'))
    check(f'quick convert downloads EPUB ({dl.value.suggested_filename})', dl.value.suggested_filename == 'The Pocket Guide to Reading Software.epub')
    dp.wait_for_selector('.card')
    shot(dp, '15b-desktop-library')
    dp.locator('.card .cover').click()
    dp.wait_for_selector('.flow [data-b]')
    dp.evaluate("document.querySelector('.flow figure.fig').scrollIntoView({block:'center'})")
    dp.wait_for_timeout(700)
    shot(dp, '16-desktop-reader')
    dp.keyboard.press('t')
    dp.wait_for_selector('.toc-item')
    dp.wait_for_timeout(200)
    shot(dp, '17-desktop-toc')

    # ---- Reading EPUB files directly (phone) ----
    import subprocess, tempfile
    epub_dir = tempfile.mkdtemp()
    subprocess.run(['node', os.path.join(ROOT, 'tools', 'pdf2epub.mjs'), os.path.join(ROOT, 'samples', 'sample-book.pdf'),
                    os.path.join(ROOT, 'samples', 'tech-sample.pdf'), '-o', epub_dir], check=True, capture_output=True)
    ec = browser.new_context(**phone)
    ep = ec.new_page()
    ep.on('pageerror', lambda e: errors.append(str(e)))
    ep.goto(args.url)
    ep.wait_for_selector('.lib-bar')
    ep.set_input_files('#pick-import', [os.path.join(epub_dir, 'sample-book.epub'), os.path.join(epub_dir, 'tech-sample.epub')])
    ep.wait_for_function("document.querySelectorAll('.card').length === 2", timeout=60000)
    check('EPUBs added with EPUB badge', ep.locator('.card .badge.fmt').count() == 2)
    check('no "export EPUB" button on EPUB books', ep.locator('.epub-btn').count() == 0)
    shot(ep, '20-epub-library')
    ep.locator('.card', has_text='Pocket Guide').locator('.cover').click()
    ep.wait_for_selector('.flow [data-b]')
    check('EPUB reader has no original-page button', ep.get_by_label('Toggle original pages').count() == 0)
    ep.evaluate("[...document.querySelectorAll('.flow figure.fig img')][1].scrollIntoView({block:'center'})")
    ep.wait_for_function("() => { const i = [...document.querySelectorAll('.flow figure.fig img')][1]; return i && i.complete && i.naturalWidth > 100; }", timeout=10000)
    check('EPUB picture shows', True)
    ep.wait_for_timeout(500)
    bars(ep)
    st = ep.locator('.bar.bottom .status').inner_text()
    check(f'EPUB printed page number in status ({st})', st.startswith('Page 2'))
    shot(ep, '21-epub-reader')
    ep.get_by_label('Back to library').click()
    ep.wait_for_selector('.card')
    ep.locator('.card', has_text='tech sample').locator('.cover').click()
    ep.wait_for_selector('.flow [data-b]')
    ep.wait_for_timeout(400)
    check('EPUB contents lines keep page numbers', ep.locator('.flow p.toc-line .pn').count() == 4)
    ep.locator('.flow p.toc-line a', has_text='Installing the Tools').click()
    ep.wait_for_timeout(700)
    bars(ep)
    st = ep.locator('.bar.bottom .status').inner_text()
    check(f'EPUB contents link jumps to its page ({st})', st.startswith('Page 2 '))
    check('EPUB code listing and note', ep.locator('.flow pre.code').count() == 1 and ep.locator('.flow .note').count() == 1)
    shot(ep, '22-epub-contents-jump')
    bars(ep)
    ep.get_by_label('Contents').click()
    ep.wait_for_selector('.toc-item')
    check('EPUB contents panel', ep.locator('.toc-item').count() >= 4)
    ec.close()

    # ---- Reading progress: what you read, chapters, bookmarks, the way back, start over ----
    rc = browser.new_context(**phone)
    rp = rc.new_page()
    rp.on('pageerror', lambda e: errors.append(str(e)))
    rp.clock.install()  # time flows normally; run_for() simulates minutes of reading
    rp.goto(args.url)
    rp.wait_for_selector('.lib-bar')
    rp.set_input_files('#pick-import', SAMPLE)
    rp.wait_for_selector('.card', timeout=60000)
    rp.locator('.card .cover').click()
    rp.wait_for_selector('.flow [data-b]')
    bars(rp)
    rp.get_by_label('Contents').click()
    rp.wait_for_selector('.toc-item')
    rp.locator('.toc-item').nth(2).click()  # jump to the middle of the book: Chapter 3
    rp.wait_for_timeout(500)
    chip = rp.locator('.backchip:not([hidden]) .back-go')
    check(f'back chip after a jump ({chip.inner_text() if chip.count() else "none"})', chip.count() == 1 and 'p. 1' in chip.inner_text())
    rp.clock.run_for(30000)  # 30 s reading chapter 3
    rp.wait_for_timeout(300)
    bars(rp)
    st = rp.locator('.bar.bottom .status').inner_text()
    check(f'status: page, time left in chapter, share read ({st})', st.startswith('Page 3') and '% read' in st and not st.endswith(' 0% read'))
    rp.get_by_label('Contents').click()
    rp.wait_for_selector('.toc-row')
    states = rp.evaluate("[...document.querySelectorAll('.toc-row')].map(r => r.classList.contains('done') ? 'done' : r.classList.contains('started') ? 'started' : 'new')")
    check(f'chapter states after reading only chapter 3 ({states})', states[2] in ('done', 'started') and states[1] == 'new' and states[3] == 'new')
    rp.wait_for_timeout(300)
    shot(rp, '24-contents-progress')
    # Mark chapter 2 as read from its row menu (read it elsewhere)
    rp.locator('.toc-row').nth(1).locator('.more').click()
    rp.locator('.toc-row').nth(1).get_by_role('button', name='Mark as read').click()
    check('chapter marked as read', 'done' in rp.locator('.toc-row').nth(1).get_attribute('class'))
    rp.keyboard.press('Escape')
    rp.wait_for_timeout(300)
    # The way back
    rp.locator('.backchip .back-go').click()
    rp.wait_for_timeout(500)
    check('back chip returns to page 1', rp.locator('.titles .sub').inner_text().startswith('Chapter 1') or rp.locator('.bar.bottom .status').inner_text().startswith('Page 1'))
    check('chip flips to the place you came from', 'p. 3' in rp.locator('.backchip .back-go').inner_text())
    # Bookmark (key B) and the Bookmarks tab
    rp.keyboard.press('b')
    rp.wait_for_timeout(300)
    check('bookmark ribbon in the text', rp.locator('.flow .bm').count() == 1)
    bars(rp)
    rp.get_by_label('More').click()
    rp.get_by_role('button', name='Bookmarks…').click()
    rp.wait_for_selector('.bm-row')
    check('bookmark listed', rp.locator('.bm-row').count() == 1)
    rp.wait_for_timeout(300)
    shot(rp, '25-bookmarks')
    rp.keyboard.press('Escape')
    rp.wait_for_timeout(1200)
    # Library card shows the share read
    bars(rp)
    rp.get_by_label('Back to library').click()
    rp.wait_for_selector('.card')
    where = rp.locator('.card .where').inner_text()
    check(f'library card: share read + chapter + page ({where})', '% read' in where and not where.startswith('0%'))
    shot(rp, '26-library-read')
    # Start over (keeps bookmarks), then reload: state persisted
    rp.locator('.card .cover').click()
    rp.wait_for_selector('.flow [data-b]')
    bars(rp)
    rp.get_by_label('More').click()
    rp.once('dialog', lambda d: d.accept())
    rp.get_by_role('button', name='Start over…').click()
    rp.wait_for_timeout(1200)
    rp.reload()
    rp.wait_for_selector('.flow [data-b]')
    rp.wait_for_timeout(500)
    bars(rp)
    st = rp.locator('.bar.bottom .status').inner_text()
    import re
    read_pct = int(re.search(r'(\d+)% read', st).group(1))
    check(f'start over: back at the beginning, (almost) nothing read ({st})', st.startswith('Page 1') and read_pct <= 2)
    check('start over keeps bookmarks', rp.locator('.flow .bm').count() == 1)
    rc.close()

    # ---- Scanned PDF (pages are only pictures): OCR in the browser ----
    oc = browser.new_context(**phone)
    op = oc.new_page()
    op.on('pageerror', lambda e: errors.append(str(e)))
    op.goto(args.url)
    op.wait_for_selector('.lib-bar')
    op.locator('#lib-settings').click()
    check('import settings offer OCR languages', op.locator('#ocr-lang option').count() == 5)
    op.keyboard.press('Escape')
    labels = []
    t0 = time.time()
    op.set_input_files('#pick-import', os.path.join(ROOT, 'samples', 'scanned-sample.pdf'))
    while time.time() - t0 < 180 and op.locator('.card').count() == 0:
        lab = op.locator('.progress-sheet .muted')
        if lab.count():
            try:
                labels.append(lab.inner_text(timeout=200))
            except Exception:
                pass
        op.wait_for_timeout(300)
    op.wait_for_selector('.card', timeout=5000)
    print(f'  (browser OCR of 4 pages: {time.time() - t0:.1f} s)')
    check('OCR progress shown while importing', any('OCR' in l for l in labels))
    check('scanned book has no "scan" badge after OCR', op.locator('.card .badge:not(.fmt)').count() == 0)
    op.locator('.card .cover').click()
    op.wait_for_selector('.flow [data-b]')
    heads = op.locator('.flow h1, .flow h2, .flow h3').all_text_contents()
    check(f'OCR chapter headings ({heads})', sum(1 for h in heads if h.strip().startswith('Chapter')) == 4)
    check('OCR table rebuilt', op.locator('.flow table tr').count() >= 5 and 'Needs OCR' in op.locator('.flow table').text_content())
    check('OCR list items', op.locator('.flow li, .flow p.li').count() >= 3)
    shot(op, '23-ocr-reader')
    # A tilted scan with a screenshot and a diagram: straightened, figures kept as pictures.
    op.goto(args.url)
    op.wait_for_selector('.lib-bar')
    op.set_input_files('#pick-import', os.path.join(ROOT, 'samples', 'scanned-figures.pdf'))
    t0 = time.time()
    while time.time() - t0 < 120 and op.locator('.card').count() < 2:
        op.wait_for_timeout(300)
    op.locator('.card', has_text='scanned-figures').or_(op.locator('.card').first).first.locator('.cover').click()
    op.wait_for_selector('.flow [data-b]')
    flow = op.locator('.flow').text_content()
    check('browser OCR: figures are pictures with captions', op.locator('.flow figure img').count() == 2 and 'Figure 2: High-level design' in flow)
    check('browser OCR: no text from inside figures', 'Load balancer' not in flow and 'Corner Noodles' not in flow)
    check('browser OCR: tilted paragraph whole', 'map and review apps. Figure 1 shows' in flow.replace('\n', ' '))
    check('browser OCR: ruled table', 'Medium' in op.locator('.flow table').text_content())
    op.locator('.flow figure').first.scroll_into_view_if_needed()
    op.wait_for_timeout(300)
    shot(op, '27-ocr-figures')
    oc.close()

    browser.close()

real_errors = [e for e in errors if 'favicon' not in e]
check(f'no console errors {real_errors[:3]}', not real_errors)
print(f'{len(failed)} FAILED: {failed}' if failed else 'ALL PASSED')
sys.exit(1 if failed else 0)
