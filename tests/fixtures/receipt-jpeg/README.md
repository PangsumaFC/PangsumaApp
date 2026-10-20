# Synthetic JPEG fixtures

Every image in this directory is generated test data, not a user attachment.

- `64x48_{baseline,progressive}_{420,422,444}.jpg`: deterministic RGB patterns generated locally with Pillow 12.3.0, JPEG quality 88, requested chroma subsampling 2/1/0.
- `2048x2048_solid_*`: solid RGB color generated with Pillow, baseline and progressive, all three sampling modes. Encoded size stays below 512 KiB; the old public jpeg-js decoder exceeded its 64 MiB allocation budget for 4:2:2 and 4:4:4 even though these satisfy browser output dimensions.
- `4000x4000_solid_progressive_420.jpg`: encoded-byte and header-dimension limits pass; decoder workspace must still exceed the unchanged 64 MiB budget and be rejected.
- `grayscale.jpg` and `cmyk.jpg`: 64×48 Pillow `L` (128) and `CMYK` (10,30,50,20), quality 85. Preserve supported one/four-component color behavior.
- `restart_{baseline,progressive}.jpg`: libjpeg-turbo cjpeg 2.1.5 from a generated 64×48 PPM pattern. Pixel `(x,y)` is `((17*x+11*y)%256,(7*x+31*y)%256,(43*x+3*y)%256)`. Command: `cjpeg -quality 85 -sample 2x2 -restart 1B [-progressive] -outfile OUTPUT INPUT.ppm`. Baseline has DRI and 11 restart markers; progressive has DRI and 254 restart markers. No marker bytes were invented by hand.

Unit tests read the checked-in byte fixtures, so CI does not require Pillow/cjpeg. Tests construct invalid mutations and interscan APP1/APP13 payloads in memory; no malformed fixture is accepted as a real image. Normalization/browser tests generate additional synthetic files locally and block every non-loopback network request.
