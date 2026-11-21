import test from "node:test";
import assert from "node:assert/strict";

import { encodeQrMatrix, renderQrSvg } from "../public/js/qr-svg.js";

function assertFinderAt(modules, r0, c0) {
  for (let dr = 0; dr < 7; dr++) {
    for (let dc = 0; dc < 7; dc++) {
      const inOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      const expected = inOuter || inCore;
      assert.equal(
        modules[r0 + dr][c0 + dc],
        expected,
        `Finder mismatch at (${r0 + dr}, ${c0 + dc})`
      );
    }
  }
}

function assertFormatCopiesMatch(modules, size) {
  for (let i = 0; i < 6; i++) {
    assert.equal(modules[i][8], modules[8][size - 1 - i], `Format bit ${i} mismatch`);
  }
  assert.equal(modules[7][8], modules[8][size - 7], "Format bit 6 mismatch");
  assert.equal(modules[8][8], modules[8][size - 8], "Format bit 7 mismatch");
  assert.equal(modules[8][7], modules[size - 7][8], "Format bit 8 mismatch");
  for (let i = 9; i < 15; i++) {
    assert.equal(modules[8][14 - i], modules[size - 15 + i][8], `Format bit ${i} mismatch`);
  }
}

function assertStructuralInvariants(payload, minVersion = 1, maxVersion = 20) {
  const { size, version, modules } = encodeQrMatrix(payload);
  assert.ok(version >= minVersion && version <= maxVersion, `Unexpected version ${version}`);
  assert.equal(size, 21 + 4 * (version - 1));
  assert.equal(modules.length, size);
  for (const row of modules) assert.equal(row.length, size);

  // Three finder patterns + white separators
  assertFinderAt(modules, 0, 0);
  assertFinderAt(modules, 0, size - 7);
  assertFinderAt(modules, size - 7, 0);
  for (let i = 0; i < 8; i++) {
    assert.equal(modules[7][i], false);
    assert.equal(modules[i][7], false);
    assert.equal(modules[7][size - 8 + i], false);
    assert.equal(modules[i][size - 8], false);
    assert.equal(modules[size - 8][i], false);
    assert.equal(modules[size - 8 + i][7], false);
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `Horizontal timing mismatch at col ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `Vertical timing mismatch at row ${i}`);
  }

  // Dark module and duplicated BCH format bits
  assert.equal(modules[4 * version + 9][8], true, "Dark module must be black");
  assertFormatCopiesMatch(modules, size);

  return { size, version, modules };
}

test("encodeQrMatrix generates valid ISO/IEC 18004 structure across short, medium & UPI payloads", () => {
  // Version 1 (capacity 14 bytes Level M -> <= 21x21)
  const shortRes = assertStructuralInvariants("HELLO", 1, 1);
  assert.equal(shortRes.size, 21);

  // Medium URL (Versions 3..5)
  assertStructuralInvariants("https://adityapdixit.me/Mise/?tab=cart&item=miso-paste", 3, 6);

  // ~260-char realistic UPI intent URI (Version >= 7, exercises 16-bit byte length & multi-block RS)
  const upiUri =
    "upi://pay?pa=swiggy@icici&pn=Swiggy%20Instamart&am=425.50&cu=INR&tr=TXN20261121ABCDEF123456&tn=Mise%20Grocery%20Order%20Indiranagar%2012th%20Main%20Bangalore&mc=5411&mode=02&purpose=00&orgid=159753&sign=MEUCIQDaFakeBase64SignaturePayloadForQrSizingCheckOnly1234567890";
  assert.ok(upiUri.length >= 250 && upiUri.length <= 280);
  const upiRes = assertStructuralInvariants(upiUri, 7, 20);
  assert.ok(upiRes.size >= 45);
});

test("renderQrSvg renders high-contrast crisp SVG with quiet zone and XML escaping", () => {
  const { size } = encodeQrMatrix("upi://pay?pa=test@upi&am=99.00&cu=INR");
  const svg = renderQrSvg("upi://pay?pa=test@upi&am=99.00&cu=INR", {
    size: 240,
    label: 'Scan & "Pay"'
  });
  const viewSize = size + 8;

  assert.match(svg, /^<svg\s+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes(`viewBox="0 0 ${viewSize} ${viewSize}"`));
  assert.ok(svg.includes('width="240" height="240"'));
  assert.ok(svg.includes('aria-label="Scan &amp; &quot;Pay&quot;"'));
  assert.ok(svg.includes('fill="#ffffff"'));
  assert.ok(svg.includes('fill="#000000"'));
});

test("encodeQrMatrix rejects empty and oversized payloads", () => {
  assert.throws(() => encodeQrMatrix(""), /cannot be empty/i);
  assert.throws(() => encodeQrMatrix("x".repeat(2500)), /too long/i);
});
