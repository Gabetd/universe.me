"""Turns the e2e screenshots (apps/desktop/test-results/*.png) into the build log's images (docs/build-log/img/*.webp, not committed)."""
import glob
import os
from PIL import Image

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.join(root, 'docs', 'build-log', 'img')
os.makedirs(out, exist_ok=True)
for path in glob.glob(os.path.join(root, 'apps', 'desktop', 'test-results', '*.png')):
    name = os.path.splitext(os.path.basename(path))[0]
    Image.open(path).convert('RGB').save(os.path.join(out, f'{name}.webp'), 'WEBP', quality=82, method=5)
    print(name)
