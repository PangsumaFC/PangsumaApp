#!/usr/bin/env python3
"""Unit checks for deterministic Pangsuma PWA icon generation."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
SCRIPT = ROOT / "scripts" / "build-pwa-icons.py"

spec = importlib.util.spec_from_file_location("build_pwa_icons", SCRIPT)
assert spec and spec.loader
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def test_source_alpha_bbox_is_cropped_and_centered() -> None:
    source = Image.open(SITE / "pangsuma-logo-transparent-1024.png").convert("RGBA")
    assert source.getchannel("A").getbbox() == (47, 48, 977, 976)
    crest = builder.cropped_crest()
    assert crest.size == (930, 928)
    for size in (192, 512):
        rendered = builder.icon(size, builder.ANY_FRACTION, crest)
        # Opaque background reaches every corner; the source crest is centered.
        assert rendered.getpixel((0, 0)) == builder.BRAND_BLUE
        assert rendered.getpixel((size - 1, size - 1)) == builder.BRAND_BLUE
        delta = ImageChops.difference(rendered, Image.new("RGB", rendered.size, builder.BRAND_BLUE))
        bbox = delta.getbbox()
        assert bbox is not None
        left, top, right, bottom = bbox
        assert abs((left + right - 1) / 2 - (size - 1) / 2) <= 2
        assert abs((top + bottom - 1) / 2 - (size - 1) / 2) <= 2


def test_maskable_crest_fits_safe_radius() -> None:
    # Maskable safe zone is radius .4*size. Builder uses .39*size diameter radius.
    assert builder.MASKABLE_FRACTION <= 0.8
    for size in (192, 512):
        rendered = builder.icon(size, builder.MASKABLE_FRACTION)
        assert rendered.size == (size, size)
        assert rendered.getpixel((0, 0)) == builder.BRAND_BLUE
        assert rendered.getpixel((size - 1, 0)) == builder.BRAND_BLUE


def test_outputs_and_manifest() -> None:
    expected = {
        "pangsuma-icon-192.png": 192,
        "pangsuma-icon-512.png": 512,
        "pangsuma-icon-maskable-192.png": 192,
        "pangsuma-icon-maskable-512.png": 512,
        "apple-touch-icon.png": 180,
        "favicon-16.png": 16,
        "favicon-32.png": 32,
        "favicon-48.png": 48,
    }
    for name, size in expected.items():
        image = Image.open(SITE / name).convert("RGBA")
        assert image.size == (size, size), (name, image.size)
        assert image.getpixel((0, 0))[:3] == builder.BRAND_BLUE
        assert image.getpixel((0, 0))[3] == 255

    manifest = json.loads((SITE / "manifest.webmanifest").read_text())
    assert manifest["id"] == manifest["start_url"] == manifest["scope"] == "/"
    assert all("?v=2026.10.18.6" in item["src"] for item in manifest["icons"])
    assert all(item["purpose"] in {"any", "maskable"} for item in manifest["icons"])
    assert all("any maskable" not in item["purpose"] for item in manifest["icons"])
    assert {item["purpose"] for item in manifest["icons"]} == {"any", "maskable"}


def test_build_is_reproducible() -> None:
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp)
        builder.build(output)
        for name in ("pangsuma-icon-192.png", "pangsuma-icon-maskable-512.png", "apple-touch-icon.png"):
            assert (output / name).read_bytes() == (SITE / name).read_bytes()


if __name__ == "__main__":
    for test in (test_source_alpha_bbox_is_cropped_and_centered, test_maskable_crest_fits_safe_radius, test_outputs_and_manifest, test_build_is_reproducible):
        test()
        print(f"PASS {test.__name__}")
