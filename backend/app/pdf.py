"""A tiny PDF writer (no dependency): A4 pages, Helvetica text, filled rectangles and lines.

Only the WinAnsi character set of the standard fonts is available, so callers should avoid symbols such as the
rupee sign (use "Rs.").
"""
import zlib

W, H = 595.28, 841.89  # A4 in points


def _esc(text):
    text = str(text).encode("cp1252", errors="replace").decode("cp1252")
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _rgb(hex_color):
    h = hex_color.lstrip("#")
    return " ".join(f"{int(h[i:i + 2], 16) / 255:.3f}" for i in (0, 2, 4))


# Helvetica average glyph widths (per 1000 em) - good enough for wrapping
_NARROW = set("iljtf.,;:!'|()[] ")
_WIDE = set("mwMW@%")


def text_width(text, size):
    w = 0
    for ch in str(text):
        w += 280 if ch in _NARROW else 830 if ch in _WIDE else 640 if ch.isupper() else 520
    return w * size / 1000


def wrap(text, size, width):
    words, lines, cur = str(text).split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if text_width(trial, size) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]


class Doc:
    def __init__(self, margin=48):
        self.pages, self.ops, self.margin = [], [], margin
        self.y = H - margin

    # ---- primitives ----
    def text(self, x, y, s, size=10, bold=False, color="#0f172a"):
        font = "F2" if bold else "F1"
        self.ops.append(f"BT {_rgb(color)} rg /{font} {size} Tf {x:.1f} {y:.1f} Td ({_esc(s)}) Tj ET")

    def rect(self, x, y, w, h, fill="#f1f5f9"):
        self.ops.append(f"{_rgb(fill)} rg {x:.1f} {y:.1f} {w:.1f} {h:.1f} re f")

    def line(self, x1, y1, x2, y2, color="#e3e8f0", width=0.8):
        self.ops.append(f"{_rgb(color)} RG {width} w {x1:.1f} {y1:.1f} m {x2:.1f} {y2:.1f} l S")

    # ---- flow helpers ----
    def ensure(self, need):
        if self.y - need < self.margin:
            self.new_page()

    def new_page(self):
        self.pages.append(self.ops)
        self.ops = []
        self.y = H - self.margin

    def para(self, s, size=10, color="#475569", bold=False, gap=4, indent=0):
        width = W - 2 * self.margin - indent
        for ln in wrap(s, size, width):
            self.ensure(size + 4)
            self.text(self.margin + indent, self.y - size, ln, size, bold, color)
            self.y -= size + 3
        self.y -= gap

    def heading(self, s, size=13):
        self.ensure(size + 26)
        self.y -= 10
        self.text(self.margin, self.y - size, s, size, True)
        self.y -= size + 6
        self.line(self.margin, self.y, W - self.margin, self.y)
        self.y -= 8

    def kv_grid(self, items, cols=3, box_h=46):
        """Stat boxes: items = [(label, value)]."""
        gap = 8
        bw = (W - 2 * self.margin - gap * (cols - 1)) / cols
        for i in range(0, len(items), cols):
            self.ensure(box_h + gap)
            for j, (label, value) in enumerate(items[i:i + cols]):
                x = self.margin + j * (bw + gap)
                self.rect(x, self.y - box_h, bw, box_h, "#f8fafc")
                self.text(x + 10, self.y - 16, label, 8.5, False, "#64748b")
                self.text(x + 10, self.y - 34, value, 13, True)
            self.y -= box_h + gap

    def table(self, header, rows, widths):
        x0 = self.margin
        self.ensure(30)
        self.rect(x0, self.y - 18, sum(widths), 18, "#f1f5f9")
        x = x0
        for h, w in zip(header, widths, strict=True):
            self.text(x + 6, self.y - 12.5, h, 8.5, True, "#475569")
            x += w
        self.y -= 18
        for r in rows:
            self.ensure(18)
            x = x0
            for v, w in zip(r, widths, strict=False):  # short rows leave trailing cells blank
                cell = str(v)
                while text_width(cell, 9) > w - 10 and len(cell) > 3:
                    cell = cell[:-2]
                self.text(x + 6, self.y - 12.5, cell if cell == str(v) else cell + "...", 9)
                x += w
            self.y -= 18
            self.line(x0, self.y, x0 + sum(widths), self.y)
        self.y -= 6

    # ---- output ----
    def render(self) -> bytes:
        pages = self.pages + ([self.ops] if self.ops else [])
        objs: list[str | bytes] = ["<< /Type /Catalog /Pages 2 0 R >>", "",  # [1] is filled in once the pages are known
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"]
        kids = []
        for n, ops in enumerate(pages, 1):
            footer = f"BT 0.392 0.455 0.545 rg /F1 8 Tf {self.margin} 24 Td (PowerPulse - page {n} of {len(pages)}) Tj ET"
            stream = zlib.compress(("\n".join(ops + [footer])).encode("cp1252", errors="replace"))
            objs.append(f"<< /Length {len(stream)} /Filter /FlateDecode >>".encode() + b"\nstream\n" + stream + b"\nendstream")
            objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> "
                        f"/Contents {len(objs)} 0 R >>")
            kids.append(f"{len(objs)} 0 R")
        objs[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
        out, offsets = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"), []
        for i, o in enumerate(objs, 1):
            offsets.append(len(out))
            body = o if isinstance(o, bytes) else o.encode("latin-1")
            out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
        out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
        out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
        return bytes(out)
