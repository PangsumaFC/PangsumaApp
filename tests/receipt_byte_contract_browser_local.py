"""Offline browser contract coverage for receipt normalization bytes and filenames."""
import base64
import io
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import expect, sync_playwright

from qa_fixture_server import serve_in_thread

ROOT = Path(__file__).resolve().parents[1]
AUDIT_PATH = Path(os.environ.get("RECEIPT_BROWSER_OUTPUT", str(ROOT / ".evidence/browser-normalized.json")))


def jpeg_fixture(subsampling: int, progressive: bool, orientation: int) -> bytes:
    image = Image.new("RGB", (2400, 1400), (19, 44, 77))
    draw = ImageDraw.Draw(image)
    for x in range(0, 2400, 80):
        draw.rectangle((x, 0, x + 40, 1400), fill=(20 + x % 180, 80 + x % 120, 130 + x % 90))
    draw.text((100, 100), f"synthetic {subsampling} {progressive} EXIF {orientation}", fill="white")
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=88, subsampling=subsampling, progressive=progressive,
               exif=Image.Exif() if orientation == 1 else _exif(orientation))
    return out.getvalue()


def _exif(orientation: int) -> bytes:
    exif = Image.Exif()
    exif[274] = orientation
    return exif.tobytes()


def main():
    fixtures = []
    for subsampling, label in ((2, "420"), (1, "422"), (0, "444")):
        for progressive in (False, True):
            for orientation in (1, 6, 8):
                fixtures.append({
                    "name": f"fixture-{label}-{'progressive' if progressive else 'baseline'}-o{orientation}.jpeg",
                    "kind": f"{label}-{'progressive' if progressive else 'baseline'}-o{orientation}",
                    "bytes": base64.b64encode(jpeg_fixture(subsampling, progressive, orientation)).decode(),
                    "orientation": orientation,
                })

    server, _ = serve_in_thread(host="127.0.0.1", port=0)
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path="/opt/google/chrome/chrome", headless=True,
                                                 args=["--no-sandbox"])
            page = browser.new_page()
            page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base + "/") else route.abort())
            page.goto(base + "/login-mock")
            if os.environ.get("RECEIPT_SCRIPT_FILE"):
                page.add_script_tag(content=Path(os.environ["RECEIPT_SCRIPT_FILE"]).read_text())
            else:
                page.add_script_tag(url=base + "/report-evidence.js")
            expect(page).to_have_url(base + "/login-mock")
            results = page.evaluate(
                """
                async ({fixtures}) => {
                  const bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                  const encode = value => { let text = ''; for (let i = 0; i < value.length; i += 0x8000) text += String.fromCharCode(...value.subarray(i, i + 0x8000)); return btoa(text); };
                  const normalized = async (fixture, makeBlob, fallback) => {
                    const raw = bytes(fixture.bytes);
                    const value = makeBlob ? new Blob([raw], {type: 'image/jpeg'}) : new File([raw], fixture.name, {type: 'image/jpeg'});
                    const original = window.createImageBitmap;
                    if (fallback) window.createImageBitmap = undefined;
                    try {
                      const n = await ReportEvidence.normalizeImage(value);
                      return {kind: fixture.kind, orientation: fixture.orientation, mimeType: n.mimeType,
                        filename: n.filename, width: n.width, height: n.height, byteLength: n.bytes.length,
                        bytesBase64: encode(n.bytes)};
                    } finally { window.createImageBitmap = original; }
                  };
                  const out = [];
                  for (const [index, fixture] of fixtures.entries()) {
                    out.push(await normalized(fixture, index % 2 === 0, index === fixtures.length - 1));
                  }
                  const longName = new File([bytes(fixtures[0].bytes)], `${'x'.repeat(250)}\u007f.final.jpeg`, {type:'image/jpeg'});
                  const long = await ReportEvidence.normalizeImage(longName);
                  const wrongMime = await ReportEvidence.normalizeImage(new Blob([bytes(fixtures[1].bytes)], {type:'application/octet-stream'}));
                  for (const type of ['', 'image/png']) {
                    const n = await ReportEvidence.normalizeImage(new File([bytes(fixtures[0].bytes)], 'x'.repeat(250), {type}));
                    out.push({kind: `declared-${type || 'empty'}`, mimeType: n.mimeType, filename: n.filename,
                      width: n.width, height: n.height, byteLength: n.bytes.length, bytesBase64: encode(n.bytes)});
                  }
                  let emptyError = '';
                  try { await ReportEvidence.normalizeImage(new File([], 'empty.jpg', {type:'image/jpeg'})); } catch (e) { emptyError = e.message; }
                  let wrongError = '';
                  try { await ReportEvidence.normalizeImage(new File([new Uint8Array([1,2,3])], 'wrong.bin', {type:'image/jpeg'})); } catch (e) { wrongError = e.message; }
                  return {out, long: {...long, bytes: undefined, byteLength: long.bytes.length, bytesBase64: encode(long.bytes)},
                    wrongMime: {filename: wrongMime.filename, mimeType: wrongMime.mimeType, width: wrongMime.width, height: wrongMime.height, byteLength: wrongMime.bytes.length, bytesBase64: encode(wrongMime.bytes)}, emptyError, wrongError};
                }
                """,
                {"fixtures": fixtures},
            )
            assert len(results["out"]) == 20
            for item in results["out"]:
                assert item["mimeType"] in ("image/jpeg", "image/png")
                assert item["byteLength"] <= 512 * 1024
                assert max(item["width"], item["height"]) <= 2048
                assert len(item["filename"]) <= 180
                assert "\x7f" not in item["filename"]
                raw = base64.b64decode(item["bytesBase64"])
                assert raw[:3] == b"\xff\xd8\xff" if item["mimeType"] == "image/jpeg" else raw[:8] == b"\x89PNG\r\n\x1a\n"
                if item.get("orientation") == 1:
                    assert (item["width"], item["height"]) == (2048, 1195)
                elif item.get("orientation") in (6, 8):
                    assert (item["width"], item["height"]) == (1195, 2048)
            assert len(results["long"]["filename"]) == 180
            assert "\x7f" not in results["long"]["filename"]
            assert results["long"]["filename"].endswith(".jpg")
            assert results["wrongMime"]["mimeType"] == "image/jpeg"
            assert results["wrongMime"]["byteLength"] <= 512 * 1024
            assert results["emptyError"]
            assert results["wrongError"]
            AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
            AUDIT_PATH.write_text(json.dumps({"source": "synthetic-loopback", "cases": results}, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps({"passed": True, "cases": len(results["out"]), "audit": str(AUDIT_PATH)}, ensure_ascii=False), flush=True)
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
