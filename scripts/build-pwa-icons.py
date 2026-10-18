#!/usr/bin/env python3
"""Build Pangsuma launcher icons from the existing transparent crest pixels.

No logo pixels are redrawn: the source is alpha-cropped, resized, and composited
onto the approved dark-blue background for reproducible PWA assets.
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "site" / "pangsuma-logo-transparent-1024.png"
BRAND_BLUE = (18, 84, 162)
ANY_FRACTION = 0.88
MASKABLE_FRACTION = 0.78  # crest diameter; radius .39, inside maskable safe radius .40


def cropped_crest(source: Path = SOURCE) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError(f"source has no non-transparent pixels: {source}")
    return image.crop(bbox)


def icon(size: int, fraction: float, crest: Image.Image | None = None) -> Image.Image:
    if size <= 0 or not 0 < fraction <= 1:
        raise ValueError("size and fraction must be positive; fraction must be <= 1")
    crest = crest or cropped_crest()
    diameter = max(1, round(size * fraction))
    scale = min(diameter / crest.width, diameter / crest.height)
    resized = crest.resize((round(crest.width * scale), round(crest.height * scale)), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), BRAND_BLUE + (255,))
    position = ((size - resized.width) // 2, (size - resized.height) // 2)
    canvas.alpha_composite(resized, position)
    return canvas.convert("RGB")


def build(output_dir: Path = ROOT / "site") -> list[Path]:
    crest = cropped_crest()
    specs = {
        "pangsuma-icon-192.png": (192, ANY_FRACTION),
        "pangsuma-icon-512.png": (512, ANY_FRACTION),
        "pangsuma-icon-maskable-192.png": (192, MASKABLE_FRACTION),
        "pangsuma-icon-maskable-512.png": (512, MASKABLE_FRACTION),
        "apple-touch-icon.png": (180, ANY_FRACTION),
        "favicon-16.png": (16, ANY_FRACTION),
        "favicon-32.png": (32, ANY_FRACTION),
        "favicon-48.png": (48, ANY_FRACTION),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for name, (size, fraction) in specs.items():
        path = output_dir / name
        icon(size, fraction, crest).save(path, format="PNG", optimize=True)
        paths.append(path)
    return paths


def build_previews(path: Path = ROOT / "artifacts" / "pwa-icon-previews.png") -> Path:
    """Save a deterministic, text-free preview of the three common launcher masks."""
    crest = cropped_crest()
    size = 512
    preview = Image.new("RGB", (size * 3, size), (235, 238, 242))
    # Circle, squircle, and rounded-square masks are previews only; source assets remain square PNGs.
    masks: Iterable[tuple[str, Image.Image]] = (
        ("circle", Image.new("L", (size, size), 0)),
        ("squircle", Image.new("L", (size, size), 0)),
        ("rounded", Image.new("L", (size, size), 0)),
    )
    for index, (kind, mask) in enumerate(masks):
        draw = ImageDraw.Draw(mask)
        if kind == "circle":
            draw.ellipse((0, 0, size - 1, size - 1), fill=255)
        elif kind == "squircle":
            draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=130, fill=255)
        else:
            draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=72, fill=255)
        tile = Image.new("RGB", (size, size), (235, 238, 242))
        tile.paste(icon(size, MASKABLE_FRACTION, crest), mask=mask)
        preview.paste(tile, (index * size, 0))
    path.parent.mkdir(parents=True, exist_ok=True)
    preview.save(path, format="PNG", optimize=True)
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / "site")
    parser.add_argument("--preview", type=Path, default=ROOT / "artifacts" / "pwa-icon-previews.png")
    args = parser.parse_args()
    paths = build(args.output_dir)
    preview = build_previews(args.preview)
    print("generated:")
    for path in paths:
        print(path)
    print(preview)


if __name__ == "__main__":
    main()
