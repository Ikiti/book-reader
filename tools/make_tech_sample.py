"""Generate samples/tech-sample.pdf: a 7-page "technical book" with the layouts that trip converters.

  page 1 (label v) : CONTENTS (letter-spaced) with right-aligned page numbers, indented entries
  page 2 (label 1) : chapter opener: big "1" + letter-spaced title, intro, bullet list (bullet drawn apart)
  page 3 (label 2) : section heading, code listing (Courier) + caption, NOTE box with label in the margin
  pages 4-6        : body text; running footers "2  Chapter 1" / "Getting Started  3" alternate
  page 7 (label 6) : two-column INDEX with sub-entries and a wrapped entry
PDF page labels: v, 1, 2, 3, 4, 5, 6 (roman front matter, then arabic).

Usage: python3 tools/make_tech_sample.py [output.pdf]
"""
import sys
import textwrap

from reportlab.lib.pagesizes import A5
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas

OUT = sys.argv[1] if len(sys.argv) > 1 else 'samples/tech-sample.pdf'
W, H = A5
L, R = 60, W - 45          # text column
c = Canvas(OUT, pagesize=A5)
c.setTitle('')             # no metadata title, like many real PDFs


def para(y, text, font='Times-Roman', size=10, lead=13, x=L, right=R, indent=12):
    """Justified-ish paragraph with a first-line indent. Returns the next y."""
    words = text.split()
    line, first = [], True
    while words:
        avail = right - x - (indent if first else 0)
        line = []
        while words and stringWidth(' '.join(line + [words[0]]), font, size) <= avail:
            line.append(words.pop(0))
        c.setFont(font, size)
        c.drawString(x + (indent if first else 0), y, ' '.join(line))
        y -= lead
        first = False
    return y - 4


def footer(left, right):
    c.setFont('Helvetica', 7)
    c.drawString(L, 30, left)
    c.drawRightString(R, 30, right)


def spaced(x, y, text, font, size):
    c.setFont(font, size)
    c.drawString(x, y, text, charSpace=size * 0.35)


FILL = ('Reading a technical book on a phone needs the text to flow again, but the code, the notes '
        'and the page numbers must survive the trip. This filler paragraph exists so that the running '
        'footers have real body text above them and the pages look like a printed book. ')

# --- page 1: contents (label v) ---
spaced(150, H - 70, 'CONTENTS', 'Helvetica-Bold', 14)
rows = [(L, '1', 'GETTING STARTED', 'Helvetica-Bold'), (L + 18, '2', 'Installing the Tools', 'Times-Roman'),
        (L + 18, '4', 'Testing the Setup', 'Times-Roman'), (L, '6', 'INDEX', 'Helvetica-Bold')]
y = H - 120
for x, num, title, font in rows:
    c.setFont(font, 10)
    c.drawString(x, y, title)
    c.setFont('Times-Roman', 10)
    c.drawRightString(R, y, num)
    y -= 20
c.showPage()

# --- page 2: chapter opener (label 1) ---
c.setFont('Helvetica-Bold', 60)
c.drawCentredString(W / 2, H - 120, '1')
spaced(95, H - 160, 'GETTING STARTED', 'Helvetica-Bold', 14)
y = para(H - 210, 'This chapter shows how to prepare a workstation for analysis. You will install a few tools, '
         'check that they work, and learn the rules that keep your own machine safe:', indent=0)
for item in ['Work inside a virtual machine that you can reset.', 'Never run samples on your daily computer.',
             'Keep notes of every command you run, so you can repeat the steps later.']:
    c.setFont('Times-Roman', 10)
    c.drawString(L, y, '•')
    for k, ln in enumerate(textwrap.wrap(item, 52)):
        c.drawString(L + 14, y, ln)
        y -= 13
    y -= 3
para(y - 4, 'With these rules in place, the next section installs the tools.')
c.showPage()

# --- page 3: section, code listing, note (label 2) ---
c.setFont('Helvetica-Bold', 12)
c.drawString(L, H - 70, 'Installing the Tools')
y = para(H - 92, 'Run the commands in Listing 1-1 in a terminal. The second line is indented on purpose, because '
         'it continues the first one.')
c.setFont('Courier', 8.5)
for ln in ['sudo apt install -y \\', '    python3-pip binutils', 'pip install pefile   # parse PE files']:
    c.drawString(L, y, ln)
    y -= 11
c.setFont('Times-Italic', 8.5)
c.drawString(L, y - 6, 'Listing 1-1: Installing the analysis tools')
y -= 34
spaced(L - 40, y, 'NOTE', 'Helvetica-Bold', 7)
for ln in ['If the installation fails, update the package list first', 'and run the commands again.']:
    c.setFont('Times-Italic', 9)
    c.drawString(L + 20, y, ln)
    y -= 12
y = para(y - 10, 'When the tools are installed, you are ready to test the setup on a harmless file.')
footer('2   Chapter 1', '')
c.showPage()

# --- pages 4-6: body text with alternating running footers ---
for label, (lf, rf) in [('3', ('', 'Getting Started   3')), ('4', ('4   Chapter 1', '')), ('5', ('', 'Getting Started   5'))]:
    y = H - 70
    if label == '4':
        c.setFont('Helvetica-Bold', 12)
        c.drawString(L, y, 'Testing the Setup')
        y -= 22
    for _ in range(3):
        y = para(y, FILL * 2)
    footer(lf, rf)
    c.showPage()

# --- page 7: index (label 6), two columns ---
spaced(170, H - 60, 'INDEX', 'Helvetica-Bold', 14)
left = [(0, 'analysis environment, 1, 2'), (1, 'virtual machine, 1'), (1, 'notes, 1'), (0, 'binutils, 2'),
        (0, 'code listings, 2'), (0, 'command line tools for'), (2, 'executable files, 2, 4'),
        (0, 'notes, keeping, 1')]
right = [(0, 'pefile, 2'), (0, 'pip, 2'), (0, 'safety rules, 1'), (1, 'daily computer, 1'), (1, 'reset, 1'),
         (0, 'setup, testing, 4'), (0, 'terminal, 2'), (0, 'workstation, 1')]
for col, items in ((L, left), (W / 2 + 8, right)):
    y = H - 100
    for lvl, text in items:
        c.setFont('Times-Roman', 9)
        c.drawString(col + 10 * lvl, y, text)
        y -= 12
footer('6   Index', '')
c.showPage()

# Page labels: v (roman), then 1, 2, 3 … (arabic)
c.addPageLabel(0, style='ROMAN_LOWER', start=5)
c.addPageLabel(1, style='ARABIC', start=1)
c.save()
print('wrote', OUT)
