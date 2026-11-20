import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentCodexHeaders, startCodexProxy } from "../src/codex-proxy.mjs";

const saveLogin = (authFile, token, accountId = "acct") => writeFileSync(authFile, JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { account_id: accountId, access_token: token },
}));

function tempAuthFile(t, prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, authFile: join(home, "auth.json") };
}

test("refreshes only a same-account bearer this proxy has seen in auth.json", (t) => {
  const { home, authFile } = tempAuthFile(t, "jev-codex-auth-");
  const seen = new Set();
  saveLogin(authFile, "stale");
  // The session starts with the token in the file; it is current, so nothing changes.
  assert.deepEqual(
    currentCodexHeaders({ authorization: "Bearer stale", "chatgpt-account-id": "acct" }, authFile, seen),
    { authorization: "Bearer stale", "chatgpt-account-id": "acct" },
  );
  saveLogin(authFile, "fresh");
  assert.deepEqual(
    currentCodexHeaders({ authorization: "Bearer stale", "chatgpt-account-id": "acct" }, authFile, seen),
    { authorization: "Bearer fresh", "chatgpt-account-id": "acct" },
  );
  assert.deepEqual(
    currentCodexHeaders({ authorization: "Bearer other", "chatgpt-account-id": "other" }, authFile, seen),
    { authorization: "Bearer other", "chatgpt-account-id": "other" },
  );
  assert.deepEqual(
    currentCodexHeaders({ authorization: "Bearer api-key" }, authFile, seen),
    { authorization: "Bearer api-key" },
  );
  assert.deepEqual(
    currentCodexHeaders({ authorization: "Bearer stale", "chatgpt-account-id": "acct" }, join(home, "missing.json"), seen),
    { authorization: "Bearer stale", "chatgpt-account-id": "acct" },
  );
});

test("an account id alone never gets the saved token attached", (t) => {
  const { authFile } = tempAuthFile(t, "jev-codex-auth-id-");
  const seen = new Set();
  saveLogin(authFile, "saved-token");
  assert.deepEqual(
    currentCodexHeaders({ "chatgpt-account-id": "acct" }, authFile, seen),
    { "chatgpt-account-id": "acct" },
  );
  assert.deepEqual(
    currentCodexHeaders({ authorization: "Bearer forged", "chatgpt-account-id": "acct" }, authFile, seen),
    { authorization: "Bearer forged", "chatgpt-account-id": "acct" },
  );
});

test("a leftover auth.json never overrides a bearer it did not issue", (t) => {
  // For example after switching Codex to keyring storage: the file keeps an old token,
  // while Codex sends a valid one that was never written there.
  const { authFile } = tempAuthFile(t, "jev-codex-auth-leftover-");
  saveLogin(authFile, "old-leftover");
  assert.deepEqual(
    currentCodexHeaders({ authorization: "Bearer from-keyring", "chatgpt-account-id": "acct" }, authFile, new Set()),
    { authorization: "Bearer from-keyring", "chatgpt-account-id": "acct" },
  );
});

async function codexProxyWithUpstream(t, authFile, extra = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.headers.authorization !== "Bearer fresh") {
      res.writeHead(401).end();
      return;
    }
    if (req.url.startsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.6-sol", supported_in_api: true }] }));
      return;
    }
    res.end("{}");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = await startCodexProxy({
    chatgptBaseURL: base,
    apiBaseURL: base,
    codexAuthFile: authFile,
    route: async () => ({ choice: "gpt-5.6-sol", confidence: 1 }),
    ...extra,
  });
  t.after(proxy.close);
  const send = (headers, input = [{ type: "additional_tools" }, { role: "user", content: "hello" }], model = "jev-router") =>
    fetch(`http://127.0.0.1:${proxy.port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, input }),
    }).then(async (response) => (await response.text(), response.status));
  return { seen, send };
}

test("uses refreshed OAuth for both cold catalog lookup and Responses forwarding", async (t) => {
  const { authFile } = tempAuthFile(t, "jev-codex-auth-proxy-");
  saveLogin(authFile, "stale");
  const { seen, send } = await codexProxyWithUpstream(t, authFile);
  // Another Codex process refreshes the file after this session started.
  saveLogin(authFile, "fresh");

  assert.equal(await send({ authorization: "Bearer stale", "chatgpt-account-id": "acct" }), 200);
  assert.deepEqual(seen.map(({ authorization }) => authorization), ["Bearer fresh", "Bearer fresh"]);
  assert.match(seen[0].url, /^\/models\?/);
  assert.equal(seen[1].url, "/responses");
});

test("the proxy never lends the saved token to a caller that only knows the account id", async (t) => {
  const { authFile } = tempAuthFile(t, "jev-codex-auth-lend-");
  saveLogin(authFile, "fresh");
  const { seen, send } = await codexProxyWithUpstream(t, authFile, { route: async () => null });

  // Both paths: the router model triggers the catalog lookup, a concrete model is forwarded as is.
  for (const model of ["jev-router", "gpt-5.6-sol"]) {
    await send({ "chatgpt-account-id": "acct" }, undefined, model);
    await send({ authorization: "Bearer forged", "chatgpt-account-id": "acct" }, undefined, model);
  }
  assert.ok(seen.some(({ url }) => /^\/models\?/.test(url)), JSON.stringify(seen));
  assert.equal(seen.filter(({ url }) => url === "/responses").length, 2, JSON.stringify(seen));
  assert.ok(seen.every(({ authorization }) => authorization !== "Bearer fresh"), JSON.stringify(seen));
});

test("image descriptions use the refreshed OAuth as well", async (t) => {
  const { authFile } = tempAuthFile(t, "jev-codex-auth-image-");
  saveLogin(authFile, "stale");
  let describedWith = null;
  const { send } = await codexProxyWithUpstream(t, authFile, {
    describe: async ({ headers }) => ((describedWith = headers.authorization), ["a chart"]),
  });
  saveLogin(authFile, "fresh");

  const image = "data:image/png;base64,iVBORw0KGgo=";
  await send(
    { authorization: "Bearer stale", "chatgpt-account-id": "acct" },
    [{ type: "additional_tools" }, { role: "user", content: [{ type: "input_text", text: "fix it" }, { type: "input_image", image_url: image }] }],
  );
  assert.equal(describedWith, "Bearer fresh");
});

test("a token remembered for one account never unlocks another", (t) => {
  const { authFile } = tempAuthFile(t, "jev-codex-auth-cross-");
  const seen = new Set();
  saveLogin(authFile, "token-a", "acct-a");
  currentCodexHeaders({ authorization: "Bearer token-a", "chatgpt-account-id": "acct-a" }, authFile, seen);
  // The user switches Codex to another account; the old account's token must not pass for it.
  saveLogin(authFile, "token-b", "acct-b");
  assert.deepEqual(
    currentCodexHeaders({ authorization: "Bearer token-a", "chatgpt-account-id": "acct-b" }, authFile, seen),
    { authorization: "Bearer token-a", "chatgpt-account-id": "acct-b" },
  );
});

test("a session in use keeps its token recognised across many refreshes", (t) => {
  const { authFile } = tempAuthFile(t, "jev-codex-auth-many-");
  const seen = new Set();
  saveLogin(authFile, "t0");
  currentCodexHeaders({ authorization: "Bearer t0", "chatgpt-account-id": "acct" }, authFile, seen);
  // More refreshes than the history keeps; the session sends its start token every time.
  for (let i = 1; i <= 300; i++) {
    saveLogin(authFile, `t${i}`);
    assert.equal(
      currentCodexHeaders({ authorization: "Bearer t0", "chatgpt-account-id": "acct" }, authFile, seen).authorization,
      `Bearer t${i}`,
      `refresh ${i}`,
    );
  }
  assert.ok(seen.size <= 256);
});
