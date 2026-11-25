import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { patchExecuteSource, patchRegistrySource } from "./patch-cursor-cloud-jwt.mjs";

describe("Dockerfile postinstall layout", () => {
  it("copies scripts before npm install so postinstall can patch", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const scriptsCopy = dockerfile.indexOf("COPY scripts");
    const npmInstall = dockerfile.indexOf("RUN npm install");
    assert.ok(scriptsCopy >= 0, "Dockerfile must COPY scripts");
    assert.ok(npmInstall > scriptsCopy, "COPY scripts must run before npm install");
  });
});

describe("cursor_cloud JWT install patch", () => {
  it("flips only the cursor_cloud JWT flag", () => {
    const source = `const cursorLocalAdapter = {
    type: "cursor",
    supportsLocalAgentJwt: true,
};
const cursorCloudAdapter = {
    type: "cursor_cloud",
    execute: cursorCloudExecute,
    models: [],
    supportsLocalAgentJwt: false,
    supportsInstructionsBundle: true,
};
const geminiLocalAdapter = {
    type: "gemini_local",
    supportsLocalAgentJwt: false,
};`;
    const first = patchRegistrySource(source);
    assert.equal(first.changed, true);
    assert.match(first.source, /type: "cursor_cloud"[\s\S]*supportsLocalAgentJwt: true/);
    assert.match(first.source, /type: "gemini_local"[\s\S]*supportsLocalAgentJwt: false/);
    const second = patchRegistrySource(first.source);
    assert.equal(second.changed, false);
  });

  it("fails before the patch: published execute.js has no public-origin JWT inject", () => {
    const source = readFileSync(new URL("./fixtures/execute.published.js", import.meta.url), "utf8");
    assert.equal(source.includes("function resolveRemotePaperclipApiUrl"), false);
    assert.equal(source.includes("env.PAPERCLIP_TOKEN = authToken"), false);
    assert.match(source, /if \(authToken\) \{\s*env\.PAPERCLIP_API_KEY = authToken;/);
    assert.match(source, /function sessionMatches\(session, envType, envName, repos\)/);
  });

  it("injects a public origin JWT into the published execute.js shape", () => {
    const source = readFileSync(new URL("./fixtures/execute.published.js", import.meta.url), "utf8");
    const first = patchExecuteSource(source);
    assert.equal(first.changed, true);
    assert.match(first.source, /function resolveRemotePaperclipApiUrl/);
    assert.match(first.source, /sessionMatches\(session, envType, envName, repos, injectedJwt\)/);
    assert.match(first.source, /paperclipJwt: true/);
    assert.match(first.source, /env\.PAPERCLIP_TOKEN = authToken/);
    const second = patchExecuteSource(first.source);
    assert.equal(second.changed, false);
  });
});
