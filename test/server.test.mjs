import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../scripts/local-server.mjs";

async function startStaticServer() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("static server serves index.html, JS/CSS modules, and sample photos securely", async () => {
  const srv = await startStaticServer();
  try {
    const home = await fetch(`${srv.baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /text\/html/);
    assert.equal(home.headers.get("x-content-type-options"), "nosniff");
    const html = await home.text();
    assert.match(html, /id="settings-view"/);
    assert.doesNotMatch(html, /config\.js/);

    const js = await fetch(`${srv.baseUrl}/js/ai-client.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /text\/javascript/);

    const css = await fetch(`${srv.baseUrl}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);

    const img = await fetch(`${srv.baseUrl}/images/miso-rigatoni.jpg`);
    assert.equal(img.status, 200);
    assert.match(img.headers.get("content-type"), /image\/jpeg/);

    const favSvg = await fetch(`${srv.baseUrl}/favicon.svg`);
    assert.equal(favSvg.status, 200);
    assert.match(favSvg.headers.get("content-type"), /image\/svg\+xml/);

    const favIco = await fetch(`${srv.baseUrl}/favicon.ico`);
    assert.equal(favIco.status, 200);
    assert.match(favIco.headers.get("content-type"), /image\/svg\+xml/);
  } finally {
    await srv.close();
  }
});

test("static server blocks path traversal, rejects non-GET methods, and returns 404 on unknown paths", async () => {
  const srv = await startStaticServer();
  try {
    const missing = await fetch(`${srv.baseUrl}/does-not-exist.js`);
    assert.equal(missing.status, 404);

    const post = await fetch(`${srv.baseUrl}/`, { method: "POST" });
    assert.equal(post.status, 405);

    const trav = await fetch(`${srv.baseUrl}/..%2fpackage.json`);
    assert.ok(trav.status === 403 || trav.status === 404);
  } finally {
    await srv.close();
  }
});
