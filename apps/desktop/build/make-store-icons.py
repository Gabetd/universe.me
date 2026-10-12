"""Makes the Microsoft Store package's tiles (build/appx/, read by electron-builder's appx target) from build/icon.png.

Run: python3 build/make-store-icons.py   (needs Pillow; after make-icon.py, when the icon changes)
"""
from pathlib import Path

from PIL import Image

here = Path(__file__).parent
out = here / "appx"
out.mkdir(exist_ok=True)
icon = Image.open(here / "icon.png").convert("RGBA")

# Square tiles are the icon itself; the wide one has it in the middle, on nothing (Windows puts the tile colour behind).
for name, size in [("StoreLogo.png", 50), ("Square44x44Logo.png", 44), ("SmallTile.png", 71), ("Square150x150Logo.png", 150), ("LargeTile.png", 310)]:
    icon.resize((size, size), Image.LANCZOS).save(out / name, optimize=True)
    print(f"wrote {out / name}")

wide = Image.new("RGBA", (310, 150), (0, 0, 0, 0))
wide.alpha_composite(icon.resize((130, 130), Image.LANCZOS), (90, 10))
wide.save(out / "Wide310x150Logo.png", optimize=True)
print(f"wrote {out / 'Wide310x150Logo.png'}")
