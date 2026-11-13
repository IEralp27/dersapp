"""Yerleşik .pptx dönüştürücü için örnek sunum üretir (python-pptx).

Kullanım: python3 scripts/pptx-fixture.py <çıktı.pptx> [--wide]
Testlerdeki src/pptx/fixtures/ornek.pptx bununla üretildi (4:3, küçük resim).
"""
import io
import sys
import zlib
import struct

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt


def png(w, h):
    """Bağımlılıksız küçük renk geçişli PNG."""
    raw = b"".join(b"\x00" + bytes(v for x in range(w) for v in (x * 255 // w, y * 255 // h, 160)) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def main(out, wide):
    prs = Presentation()
    if wide:
        prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    W, H = prs.slide_width, prs.slide_height

    # 1: başlık slaytı
    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = "Şekil ve Ölçü: Güç İçin Çığır"
    s.placeholders[1].text = "Işık, ağaç, öğrenci, çiçek — İĞÜŞÇÖ ığüşçö"
    s.notes_slide.notes_text_frame.text = "Not: ölçüm hatası ±%2 olarak alınır."

    # 2: madde işaretli liste (seviyeler)
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = "Mekatronik Sistemler"
    tf = s.placeholders[1].text_frame
    tf.text = "Algılayıcılar (sensörler) ölçüm yapar"
    for text, lvl in [("Sıcaklık, basınç, konum", 1), ("Eyleyiciler: motor, valf, piston", 0), ("Doğru akım motoru hız denetimi", 1), ("Denetleyici: PLC ya da mikrodenetleyici", 0)]:
        p = tf.add_paragraph()
        p.text = text
        p.level = lvl

    # 3: resim + metin kutusu
    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Resimli slayt"
    s.shapes.add_picture(io.BytesIO(png(64 if not wide else 320, 48 if not wide else 240)), Inches(0.6), Inches(1.8), Inches(4), Inches(3))
    tb = s.shapes.add_textbox(Inches(5), Inches(2), Inches(4), Inches(2))
    tb.text_frame.word_wrap = True
    tb.text_frame.text = "Şekil 1: Sistem çıkışı ğ ü ş ı ö ç"
    r = tb.text_frame.paragraphs[0].runs[0]
    r.font.size = Pt(20)
    r.font.bold = True
    r.font.color.rgb = RGBColor(0xC0, 0x30, 0x30)

    # 4: tablo
    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Ölçüm Tablosu"
    rows, cols = 4, 3
    tbl = s.shapes.add_table(rows, cols, Inches(0.8), Inches(1.8), W - Inches(1.6), Inches(2.4)).table
    data = [["Büyüklük", "Birim", "Değer"], ["Gerilim", "V", "12"], ["Akım", "A", "0,5"], ["Güç", "W", "6"]]
    for i in range(rows):
        for j in range(cols):
            tbl.cell(i, j).text = data[i][j]

    # 5: renkli arka plan + şekiller + numaralı liste
    s = prs.slides.add_slide(prs.slide_layouts[6])
    bg = s.background.fill
    bg.solid()
    bg.fore_color.rgb = RGBColor(0x1E, 0x3A, 0x5F)
    shp = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.5), Inches(0.5), Inches(4), Inches(1.2))
    shp.text = "Yuvarlak köşeli kutu"
    ell = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(5), Inches(0.5), Inches(2), Inches(1.5))
    ell.fill.solid()
    ell.fill.fore_color.rgb = RGBColor(0xF0, 0xA0, 0x20)
    ell.text = "Daire"
    arr = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(0.5), Inches(2.2), Inches(3), Inches(0.8))
    tb = s.shapes.add_textbox(Inches(0.5), Inches(3.4), Inches(8), Inches(3))
    tf = tb.text_frame
    tf.word_wrap = True
    for i, t in enumerate(["Birinci adım: güç kaynağını bağla", "İkinci adım: çıkışı ölç", "Üçüncü adım: sonucu çiz"]):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = t
        p.runs[0].font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        p.runs[0].font.size = Pt(24)
        pPr = p._p.get_or_add_pPr()
        pPr.set("marL", "457200")
        pPr.set("indent", "-457200")
        an = pPr.makeelement("{http://schemas.openxmlformats.org/drawingml/2006/main}buAutoNum", {"type": "arabicPeriod"})
        pPr.append(an)

    # 6: gizli slayt (çıktıda olmamalı)
    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Gizli slayt"
    s._element.set("show", "0")

    prs.save(out)


if __name__ == "__main__":
    main(sys.argv[1], "--wide" in sys.argv)
