import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.mjs";
import { startCodexProxy } from "../src/codex-proxy.mjs";
import { startAgyProxy } from "../src/agy-proxy.mjs";
import { startGlmProxy } from "../src/glm-proxy.mjs";

// Nothing listens on port 9; a request that got past the guard would fail upstream instead.
const DEAD = "http://127.0.0.1:9";
const route = async () => null;
const proxies = {
  claude: () => startProxy({ upstreamURL: DEAD, route }),
  codex: () => startCodexProxy({ chatgptBaseURL: DEAD, apiBaseURL: DEAD, route }),
  agy: () => startAgyProxy({ upstream: DEAD, route }),
  glm: () => startGlmProxy({ upstream: DEAD, route }),
};

function send(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

for (const [name, start] of Object.entries(proxies)) {
  test(`${name} proxy refuses browser and DNS-rebinding requests`, async (t) => {
    const proxy = await start();
    t.after(() => proxy.close());
    assert.equal(await send(proxy.port, { Origin: "https://evil.example" }), 403, "a cross-site page sends Origin");
    assert.equal(await send(proxy.port, { Host: `evil.example:${proxy.port}` }), 403, "a rebinding page keeps its own Host");
    assert.notEqual(await send(proxy.port, { Host: `127.0.0.1:${proxy.port}` }), 403, "the CLI's own request passes");
  });
}
