#!/usr/bin/env python3
"""Erzeugt public/icons/icon.svg: Ibu Padi (Reismutter), ein Bündel aus sieben gebogenen Reisähren,
schwarz auf Grün. Danach: node scripts/make-icons.cjs für die PNG-Größen."""
import math, os

BG, FG = "#5DB574", "#0B0F0C"
S = 512
out = []
def stalk(x0, y0, cx, cy, x1, y1, bow, n=7, size=1.0):
    """Halm als quadratische Kurve, oben eine gebogene Rispe aus Körnern."""
    out.append(f'<path d="M{x0} {y0} Q{cx} {cy} {x1} {y1}" stroke="{FG}" stroke-width="12" fill="none" stroke-linecap="round"/>')
    # Rispe: hängt vom Halmende in Richtung bow (-1 links, +1 rechts) nach unten
    px, py = x1, y1
    ang0 = -math.pi / 2 + bow * 0.75
    for i in range(n):
        t = i / (n - 1)
        ang = ang0 + bow * t * 1.55         # Ähre neigt sich nach unten („padi semakin berisi, semakin tunduk“)
        step = 14.5 * size
        px += math.cos(ang) * step
        py += math.sin(ang) * step
        deg = math.degrees(ang) + 90
        rx, ry = 7.5 * size * (1 - 0.3 * t), 13 * size * (1 - 0.3 * t)
        for side in (-1, 1):                 # Körner beidseitig
            ox = math.cos(ang + side * math.pi / 2) * 8 * size
            oy = math.sin(ang + side * math.pi / 2) * 8 * size
            out.append(f'<ellipse cx="{px+ox:.1f}" cy="{py+oy:.1f}" rx="{rx:.1f}" ry="{ry:.1f}" transform="rotate({deg + side*28:.1f} {px+ox:.1f} {py+oy:.1f})" fill="{FG}"/>')
        out.append(f'<path d="M{px-math.cos(ang)*step:.1f} {py-math.sin(ang)*step:.1f} L{px:.1f} {py:.1f}" stroke="{FG}" stroke-width="7" stroke-linecap="round"/>')

base_y = 400
# sieben Halme (bei der Ernte wurden die ersten Ähren als Bündel geschnitten): x-Ende, Höhe, Biegerichtung, Größe
spec = [(-112, 236, -1, 0.85), (-76, 186, -1, 0.92), (-38, 148, -1, 0.98), (0, 124, 1, 1.0),
        (38, 148, 1, 0.98), (76, 186, 1, 0.92), (112, 236, 1, 0.85)]
for dx, top, bow, size in spec:
    x1 = 256 + dx
    stalk(256 + dx * 0.1, base_y - 50, 256 + dx * 0.55, (base_y + top) / 2, x1, top, bow, size=size)
# Bindung (das Bündel wird zusammengebunden)
out.append(f'<rect x="218" y="330" width="76" height="24" rx="8" fill="{FG}"/>')
out.append(f'<rect x="226" y="360" width="60" height="11" rx="5.5" fill="{FG}"/>')
# kurze Stoppeln unter der Bindung
for dx in (-20, -10, 0, 10, 20):
    out.append(f'<path d="M{256+dx*0.5} 374 L{256+dx} 420" stroke="{FG}" stroke-width="10" stroke-linecap="round"/>')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}">
  <title>Ibu Padi – die Reismutter</title>
  <rect width="{S}" height="{S}" rx="112" fill="{BG}"/>
  <g transform="translate(0 30)">
  {chr(10).join(out)}
  </g>
</svg>
'''
p = os.path.join(os.path.dirname(__file__), "..", "public", "icons", "icon.svg")
open(p, "w").write(svg)
print("geschrieben:", os.path.normpath(p), len(svg), "Bytes")
