"""Generates build/icon.png (1024x1024). electron-builder derives the .ico/.icns from it.

Run: python3 build/make-icon.py   (needs Pillow)
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 1024
random.seed(7)

# Rounded-square background with a deep-space gradient.
bg = Image.new("RGBA", (S, S))
px = bg.load()
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S)
        px[x, y] = (int(14 + 30 * t), int(18 + 10 * t), int(48 + 40 * t), 255)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((40, 40, S - 40, S - 40), radius=220, fill=255)
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(bg, (0, 0), mask)

stars = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(stars)
for _ in range(140):
    x, y, r = random.randint(90, S - 90), random.randint(90, S - 90), random.choice([1, 1, 2, 2, 3])
    d.ellipse((x - r, y - r, x + r, y + r), fill=(230, 235, 255, random.randint(90, 230)))
icon.alpha_composite(Image.composite(stars, Image.new("RGBA", (S, S)), mask))

cx, cy, R = S // 2, S // 2 + 10, 250

# Glow behind the planet.
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse((cx - R - 60, cy - R - 60, cx + R + 60, cy + R + 60), fill=(122, 162, 255, 120))
icon.alpha_composite(glow.filter(ImageFilter.GaussianBlur(50)))

# Back half of the orbit ring.
ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(ring).ellipse((cx - 400, cy - 130, cx + 400, cy + 130), outline=(169, 139, 255, 230), width=22)
back = ring.crop((0, 0, S, cy))
icon.alpha_composite(back, (0, 0))

# Planet: shaded sphere with continents.
planet = Image.new("RGBA", (S, S), (0, 0, 0, 0))
pp = planet.load()
for y in range(cy - R, cy + R):
    for x in range(cx - R, cx + R):
        dx, dy = (x - cx) / R, (y - cy) / R
        if dx * dx + dy * dy <= 1:
            dz = math.sqrt(max(0.0, 1 - dx * dx - dy * dy))
            light = max(0.15, -0.5 * dx - 0.6 * dy + 0.62 * dz)
            pp[x, y] = (int(40 + 60 * light), int(110 + 120 * light), int(170 + 80 * light), 255)
pd = ImageDraw.Draw(planet)
for (ox, oy, w, h) in [(-120, -80, 170, 110), (60, -150, 120, 80), (40, 40, 190, 120), (-170, 90, 110, 80)]:
    pd.ellipse((cx + ox, cy + oy, cx + ox + w, cy + oy + h), fill=(90, 170, 110, 230))
pmask = Image.new("L", (S, S), 0)
ImageDraw.Draw(pmask).ellipse((cx - R, cy - R, cx + R, cy + R), fill=255)
icon.alpha_composite(Image.composite(planet, Image.new("RGBA", (S, S)), pmask))

# Front half of the ring, over the planet.
icon.alpha_composite(ring.crop((0, cy, S, S)), (0, cy))

# Small moon.
ImageDraw.Draw(icon).ellipse((cx + 300, cy - 300, cx + 370, cy - 230), fill=(240, 225, 190, 255))

out = Path(__file__).with_name("icon.png")
icon.save(out)
print(f"wrote {out}")
