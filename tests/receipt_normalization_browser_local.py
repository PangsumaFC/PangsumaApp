"""Local, offline browser coverage for ReportEvidence.normalizeImage."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from qa_fixture_server import serve_in_thread

ROOT = Path(__file__).resolve().parents[1]


def main():
    server, _ = serve_in_thread(host="127.0.0.1", port=0)
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path="/opt/google/chrome/chrome",
                headless=True,
                args=["--no-sandbox"],
            )
            page = browser.new_page()
            page.route(
                "**/*",
                lambda route: route.continue_()
                if route.request.url.startswith(base + "/")
                else route.abort(),
            )
            page.goto(base + "/login-mock")
            page.add_script_tag(url=base + "/report-evidence.js")
            expect(page).to_have_url(base + "/login-mock")

            results = page.evaluate(
                """
                async () => {
                  const signature = bytes => Array.from(bytes.slice(0, 8));
                  const canvasFile = async (name, type, width, height, mime = type) => {
                    const canvas = document.createElement('canvas');
                    canvas.width = width; canvas.height = height;
                    const ctx = canvas.getContext('2d', {alpha: false});
                    const gradient = ctx.createLinearGradient(0, 0, width, height);
                    gradient.addColorStop(0, '#102030');
                    gradient.addColorStop(0.5, '#d09040');
                    gradient.addColorStop(1, '#f0f0f0');
                    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, .86));
                    return new File([blob], name, {type});
                  };
                  const rejectMessage = async (file) => {
                    try { await ReportEvidence.normalizeImage(file); return null; }
                    catch (error) { return error.message; }
                  };
                  const png = await canvasFile('synthetic-source.weird', '', 2400, 1200, 'image/png');
                  const octet = await canvasFile('synthetic-photo.bin', 'application/octet-stream', 2400, 1200, 'image/jpeg');
                  const jpeg = await canvasFile('synthetic-receipt.original', 'image/jpeg', 3000, 1000, 'image/jpeg');
                  const pngResult = await ReportEvidence.normalizeImage(png);
                  const octetResult = await ReportEvidence.normalizeImage(octet);
                  const jpegResult = await ReportEvidence.normalizeImage(jpeg);
                  const tooLarge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', {type:'image/png'});
                  const huge = await canvasFile('huge.jpg', 'image/jpeg', 4097, 4097, 'image/jpeg');
                  return {
                    png: {mime: pngResult.mimeType, filename: pngResult.filename, width: pngResult.width, height: pngResult.height, size: pngResult.blob.size, signature: signature(pngResult.bytes)},
                    octet: {mime: octetResult.mimeType, filename: octetResult.filename, width: octetResult.width, height: octetResult.height, size: octetResult.blob.size, signature: signature(octetResult.bytes)},
                    jpeg: {mime: jpegResult.mimeType, filename: jpegResult.filename, width: jpegResult.width, height: jpegResult.height, size: jpegResult.blob.size, signature: signature(jpegResult.bytes)},
                    svg: await rejectMessage(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'vector.svg', {type:'image/svg+xml'})),
                    heic: await rejectMessage(new File([new Uint8Array([0,1,2,3])], 'photo.heic', {type:'image/heic'})),
                    tooLarge: await rejectMessage(tooLarge),
                    huge: await rejectMessage(huge),
                  };
                }
                """
            )

            assert results["png"]["mime"] == "image/png"
            assert results["png"]["filename"] == "synthetic-source.png"
            assert results["png"]["signature"] == [137, 80, 78, 71, 13, 10, 26, 10]
            assert max(results["png"]["width"], results["png"]["height"]) <= 2048
            assert results["png"]["size"] <= 512 * 1024

            assert results["octet"]["mime"] == "image/jpeg"
            assert results["octet"]["filename"] == "synthetic-photo.jpg"
            assert results["octet"]["signature"][:3] == [255, 216, 255]
            assert max(results["octet"]["width"], results["octet"]["height"]) <= 2048
            assert results["octet"]["size"] <= 512 * 1024

            assert results["jpeg"]["mime"] == "image/jpeg"
            assert results["jpeg"]["filename"] == "synthetic-receipt.jpg"
            assert results["jpeg"]["signature"][:3] == [255, 216, 255]
            assert max(results["jpeg"]["width"], results["jpeg"]["height"]) <= 2048
            assert results["jpeg"]["size"] <= 512 * 1024

            assert "SVG" in results["svg"]
            assert "JPG atau PNG" in results["heic"]
            assert "10 MB" in results["tooLarge"]
            assert "16 megapiksel" in results["huge"]
            print(json.dumps({"passed": True, "cases": results}, ensure_ascii=False), flush=True)
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
