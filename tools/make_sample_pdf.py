"""Generate samples/sample-book.pdf: a 4-page test document for the reader.

Page 1: title + chapter 1 (plain paragraphs, a bullet list)
Page 2: chapter 2 with an embedded image + caption
Page 3: chapter 3 with a bordered table
Page 4: chapter 4 laid out in two columns (article style)
Every page has a running header and a page-number footer (the reader should drop them).
The PDF has bookmarks (outline) so the reader can build a table of contents.

Usage: python3 tools/make_sample_pdf.py [output.pdf]
"""
import sys
from io import BytesIO

from PIL import Image, ImageDraw
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, Frame, FrameBreak, Image as RLImage, NextPageTemplate,
                                PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle)

OUT = sys.argv[1] if len(sys.argv) > 1 else "samples/sample-book.pdf"
W, H = A4
MARGIN = 20 * mm

styles = getSampleStyleSheet()
body = ParagraphStyle("body", parent=styles["BodyText"], fontName="Times-Roman", fontSize=11, leading=15,
                      spaceAfter=8)
h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=20, leading=24,
                    spaceAfter=10)
title = ParagraphStyle("title", parent=h1, fontSize=28, leading=34, alignment=1, spaceAfter=4)
subtitle = ParagraphStyle("subtitle", parent=body, fontName="Helvetica-Oblique", fontSize=12, alignment=1,
                          spaceAfter=18)
caption = ParagraphStyle("caption", parent=body, fontName="Helvetica-Oblique", fontSize=9, alignment=1)
bullet = ParagraphStyle("bullet", parent=body, leftIndent=14, bulletIndent=4, spaceAfter=3)


class Heading(Paragraph):
    """Paragraph that registers a PDF bookmark when drawn."""

    def __init__(self, text, key):
        super().__init__(text, h1)
        self.key = key

    def draw(self):
        self.canv.bookmarkPage(self.key)
        self.canv.addOutlineEntry(self.getPlainText(), self.key, level=0)
        super().draw()


def header_footer(canv, doc):
    canv.saveState()
    canv.setFont("Helvetica", 8)
    canv.setFillColor(colors.grey)
    canv.drawString(MARGIN, H - 12 * mm, "The Pocket Guide to Reading Software")
    canv.drawRightString(W - MARGIN, 10 * mm, str(doc.page))
    canv.restoreState()


def make_figure_png():
    """A small bar-chart style illustration, so the test has a real raster image."""
    img = Image.new("RGB", (900, 500), (250, 248, 240))
    d = ImageDraw.Draw(img)
    d.rectangle([40, 40, 860, 460], outline=(60, 60, 60), width=4)
    bars = [(120, 300, (220, 90, 70)), (300, 180, (70, 140, 210)), (480, 240, (90, 170, 100)),
            (660, 110, (230, 170, 50))]
    for x, top, col in bars:
        d.rectangle([x, top, x + 120, 420], fill=col, outline=(40, 40, 40), width=3)
    d.line([80, 420, 830, 420], fill=(40, 40, 40), width=4)
    d.ellipse([700, 70, 820, 190], fill=(255, 210, 80), outline=(160, 120, 20), width=4)
    buf = BytesIO()
    img.save(buf, "PNG")
    buf.seek(0)
    return buf


LOREM = [
    "Reading on a phone is different from reading on paper. A printed page has a fixed width, but a phone "
    "screen is narrow, so the text has to flow again to fit. This process is called reflow, and it is the "
    "main job of this reader.",
    "The reader opens a PDF, finds the lines of text on each page, joins them into paragraphs, and shows "
    "them in a font and size that you choose. Pictures and tables are kept, so nothing important is lost "
    "when the layout changes.",
    "It also remembers where you stopped. When you open the book again, it jumps back to the same chapter "
    "and the same place on the page, on any device where you saved the book.",
]

story = []
story.append(Spacer(1, 20 * mm))
story.append(Paragraph("The Pocket Guide to Reading Software", title))
story.append(Paragraph("A four-page sample for testing the Book Reader", subtitle))
story.append(Heading("Chapter 1: Why Reflow Matters", "ch1"))
for p in LOREM:
    story.append(Paragraph(p, body))
story.append(Paragraph("A good reader should do three things well:", body))
for b in ["show text at a comfortable size,", "keep figures and tables intact, and",
          "make it easy to save a note from any passage."]:
    story.append(Paragraph(b, bullet, bulletText="•"))
story.append(Paragraph(
    "The rest of this sample tests each of these. Chapter 2 has a picture, Chapter 3 has a table, and "
    "Chapter 4 is set in two columns like a journal article.", body))
story.append(PageBreak())

story.append(Heading("Chapter 2: Keeping Pictures", "ch2"))
story.append(Paragraph(
    "Figures carry information that words cannot. When a page is reflowed, each picture should stay next to "
    "the text that talks about it, and it should scale to the width of the screen.", body))
story.append(Spacer(1, 4 * mm))
story.append(RLImage(make_figure_png(), width=150 * mm, height=150 * mm * 500 / 900))
story.append(Spacer(1, 2 * mm))
story.append(Paragraph("Figure 1. Pages read per day, by device type.", caption))
story.append(Spacer(1, 4 * mm))
story.append(Paragraph(
    "Below the figure, the text continues as normal. The reader should place this paragraph after the "
    "picture and the caption, in the same order as on the printed page.", body))
story.append(PageBreak())

story.append(Heading("Chapter 3: Keeping Tables", "ch3"))
story.append(Paragraph(
    "Tables are harder than pictures, because their meaning comes from rows and columns. The reader turns "
    "a table with ruled lines back into a real table, so the text inside it can use your chosen font.", body))
data = [["Format", "Reflow", "Images", "Best for"],
        ["PDF", "Needs work", "Yes", "Print layouts"],
        ["EPUB", "Built in", "Yes", "Novels"],
        ["Plain text", "Built in", "No", "Notes"],
        ["Scanned PDF", "Needs OCR", "Yes", "Old books"]]
t = Table(data, colWidths=[38 * mm, 35 * mm, 25 * mm, 45 * mm])
t.setStyle(TableStyle([
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 10),
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#dde6f0")),
    ("GRID", (0, 0), (-1, -1), 0.8, colors.black),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
]))
story.append(Spacer(1, 3 * mm))
story.append(t)
story.append(Spacer(1, 3 * mm))
story.append(Paragraph("Table 1. How common formats handle reflow.", caption))
story.append(Spacer(1, 4 * mm))
story.append(Paragraph(
    "A scanned PDF is only a set of photos of pages. It has no text layer, so the reader must run optical "
    "character recognition (OCR) on it before it can reflow anything.", body))
story.append(NextPageTemplate("twocol"))
story.append(PageBreak())

story.append(Heading("Chapter 4: Two-Column Articles", "ch4"))
col_text = [
    "Many journal articles use two narrow columns. If a reader reads straight across the page, it mixes "
    "lines from both columns and the result makes no sense.",
    "To avoid this, the reader looks for the gap between the columns. It reads the whole left column first, "
    "from top to bottom, and only then moves to the right column.",
    "This works for most simple layouts. Pages with three columns, side notes, or text that wraps around "
    "pictures are harder, and may need the original page view instead.",
    "The original page view is always available from the toolbar. It shows the page exactly as it was "
    "printed, which is the safest choice for complex layouts such as forms and maps.",
    "The left column ends here, and the right column begins with the next paragraph. If the order is "
    "right, the sentence about the gap comes before the sentence about the original view.",
    "The right column starts here. This is the first paragraph of the second column, and it should appear "
    "after everything in the left column.",
    "Notes are saved together with the chapter and page where they were taken, so you can always find the "
    "passage again later.",
    "You can send a note to Google Keep through the share menu on Android, or copy it and open Keep on "
    "Windows. Notes can also go to Obsidian or be exported as Markdown.",
    "This is the last paragraph of the sample book. If you can read it in order, the two-column test "
    "passed.",
]
for i, p in enumerate(col_text):
    story.append(Paragraph(p, body))
    if p.startswith("The left column ends here"):
        story.append(FrameBreak())  # force the rest into the right column


doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN,
                      bottomMargin=MARGIN, title="The Pocket Guide to Reading Software",
                      author="Book Reader test suite")
full = Frame(MARGIN, MARGIN, W - 2 * MARGIN, H - 2 * MARGIN, id="full")
gap = 8 * mm
colw = (W - 2 * MARGIN - gap) / 2
head_h = 18 * mm
left = Frame(MARGIN, MARGIN, colw, H - 2 * MARGIN - head_h, id="left")
right = Frame(MARGIN + colw + gap, MARGIN, colw, H - 2 * MARGIN - head_h, id="right")
headf = Frame(MARGIN, H - MARGIN - head_h, W - 2 * MARGIN, head_h, id="head")
doc.addPageTemplates([
    PageTemplate(id="onecol", frames=[full], onPage=header_footer),
    PageTemplate(id="twocol", frames=[headf, left, right], onPage=header_footer),
])
doc.build(story)
print("wrote", OUT)
