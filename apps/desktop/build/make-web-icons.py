"""Makes the phone app's home-screen icons (src/renderer/public/) from build/icon.png.

Run: python3 build/make-web-icons.py   (needs Pillow; after make-icon.py, when the icon changes)
"""
from pathlib import Path

from PIL import Image

here = Path(__file__).parent
out = here.parent / "src" / "renderer" / "public"
out.mkdir(parents=True, exist_ok=True)
icon = Image.open(here / "icon.png").convert("RGBA")

# Edge to edge, for the phone to round itself (iOS) or cut to its own shape (Android's maskable icons):
# the rounded square without its margin, on the space colour so no corner is left clear.
square = Image.new("RGBA", icon.size, (14, 18, 48, 255))
square.alpha_composite(icon)
full = square.crop((40, 40, icon.width - 40, icon.height - 40))

for name, image, size in [
    ("icon-192.png", icon, 192),
    ("icon-512.png", icon, 512),
    ("icon-maskable-512.png", full, 512),
    ("apple-touch-icon.png", full, 180),
]:
    image.resize((size, size), Image.LANCZOS).save(out / name, optimize=True)
    print(f"wrote {out / name}")
