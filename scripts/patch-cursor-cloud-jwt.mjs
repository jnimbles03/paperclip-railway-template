#!/usr/bin/env node
/**
 * CAD-1244 hotfix: Cursor Cloud workers never received a Paperclip run JWT.
 *
 * Until @paperclipai/server publishes supportsLocalAgentJwt=true for
 * cursor_cloud (and the adapter injects a public PAPERCLIP_API_URL), patch
 * the installed packages after npm install. Idempotent: already-patched
 * files are left unchanged.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PATCH_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");

function resolveFirst(paths) {
  return paths.find((p) => existsSync(p)) ?? null;
}

function replaceOnce(source, find, replace, label) {
  if (source.includes(replace) && !source.includes(find)) {
    return { source, changed: false, status: `already patched (${label})` };
  }
  const count = source.split(find).length - 1;
  if (count === 0) {
    return { source, changed: false, status: `skip (${label}: pattern not found)` };
  }
  if (count !== 1) {
    throw new Error(`${label}: expected 1 match, found ${count}`);
  }
  return { source: source.replace(find, replace), changed: true, status: `patched (${label})` };
}

export function patchRegistrySource(source) {
  const find = `const cursorCloudAdapter = {
    type: "cursor_cloud",`;
  const idx = source.indexOf(find);
  if (idx < 0) {
    if (source.includes('type: "cursor_cloud"') && source.includes("supportsLocalAgentJwt: true")) {
      return { source, changed: false, status: "already patched (cursor_cloud JWT flag)" };
    }
    return { source, changed: false, status: "skip (cursor_cloud adapter not found)" };
  }
  const window = source.slice(idx, idx + 700);
  if (window.includes("supportsLocalAgentJwt: true")) {
    return { source, changed: false, status: "already patched (cursor_cloud JWT flag)" };
  }
  const flag = "supportsLocalAgentJwt: false";
  const flagAt = window.indexOf(flag);
  if (flagAt < 0) {
    throw new Error("cursor_cloud adapter found but JWT flag was not false");
  }
  const abs = idx + flagAt;
  return {
    source: source.slice(0, abs) + "supportsLocalAgentJwt: true" + source.slice(abs + flag.length),
    changed: true,
    status: "patched (cursor_cloud JWT flag)",
  };
}

export function patchExecuteSource(source) {
  let next = source;
  let changed = false;
  const steps = [];

  const jwtBlock = replaceOnce(
    next,
    `    if (authToken) {
        env.PAPERCLIP_API_KEY = authToken;
    }
    // cursor_cloud runs remotely in Cursor's cloud and is intentionally not
    // issued a Paperclip run JWT (registry: supportsLocalAgentJwt=false).
    // buildPaperclipEnv always sets PAPERCLIP_API_URL, defaulting to the local
    // runtime host — which a remote worker can neither reach nor authenticate
    // against, so any agent-initiated Paperclip API call would fail with a 401
    // (or be unreachable) and add noise. When there is no usable key, drop the
    // callback wiring so cloud-side Paperclip tools degrade to a clean no-op.
    // Run results are delivered server-side via the Cursor Agent SDK (getRun /
    // wait), not through this callback, so nothing is lost.
    if (!trimNullable(env.PAPERCLIP_API_KEY)) {
        delete env.PAPERCLIP_API_URL;
        delete env.PAPERCLIP_API_BRIDGE_MODE;
    }`,
    `    const remoteApiUrl = resolveRemotePaperclipApiUrl(env.PAPERCLIP_API_URL);
    if (authToken && remoteApiUrl) {
        env.PAPERCLIP_API_KEY = authToken;
        env.PAPERCLIP_TOKEN = authToken;
        env.PAPERCLIP_API_URL = remoteApiUrl;
    }
    else {
        delete env.PAPERCLIP_API_KEY;
        delete env.PAPERCLIP_TOKEN;
        delete env.PAPERCLIP_API_URL;
        delete env.PAPERCLIP_API_BRIDGE_MODE;
    }`,
    "execute JWT public origin",
  );
  next = jwtBlock.source;
  changed = changed || jwtBlock.changed;
  steps.push(jwtBlock.status);

  if (jwtBlock.changed && !next.includes("function resolveRemotePaperclipApiUrl")) {
    const helpers = `function isLoopbackHostname(hostname) {
    const host = hostname.trim().toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" || host === "[::1]";
}
function originIfRemote(raw) {
    const value = trimNullable(raw);
    if (!value)
        return null;
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return null;
        if (isLoopbackHostname(url.hostname))
            return null;
        return \`\${url.protocol}//\${url.host}\`;
    }
    catch {
        return null;
    }
}
function resolveRemotePaperclipApiUrl(builtInApiUrl) {
    return (originIfRemote(process.env.PAPERCLIP_PUBLIC_URL) ??
        originIfRemote(process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL) ??
        originIfRemote(process.env.PAPERCLIP_API_URL) ??
        originIfRemote(builtInApiUrl));
}
`;
    next = next.replace(
      "function trimNullable(value) {\n    return typeof value === \"string\" && value.trim().length > 0 ? value.trim() : null;\n}\n",
      "function trimNullable(value) {\n    return typeof value === \"string\" && value.trim().length > 0 ? value.trim() : null;\n}\n" + helpers,
    );
    if (!next.includes("function resolveRemotePaperclipApiUrl")) {
      throw new Error("failed to inject resolveRemotePaperclipApiUrl helper");
    }
  }

  const sessionFn = replaceOnce(
    next,
    `function sessionMatches(session, envType, envName, repos) {
    if (!session)
        return false;
    if ((session.envType ?? "cloud") !== envType)
        return false;`,
    `function sessionMatches(session, envType, envName, repos, requirePaperclipJwt) {
    if (!session)
        return false;
    if (requirePaperclipJwt && session.paperclipJwt !== true)
        return false;
    if ((session.envType ?? "cloud") !== envType)
        return false;`,
    "sessionMatches JWT gate",
  );
  next = sessionFn.source;
  changed = changed || sessionFn.changed;
  steps.push(sessionFn.status);

  const reuse = replaceOnce(
    next,
    "    const remoteEnv = buildWakeEnv(ctx, envConfig);\n    const session = readSession(runtime.sessionParams)",
    "    const remoteEnv = buildWakeEnv(ctx, envConfig);\n    const injectedJwt = Boolean(trimNullable(remoteEnv.PAPERCLIP_API_KEY));\n    const session = readSession(runtime.sessionParams)",
    "injectedJwt binding",
  );
  next = reuse.source;
  changed = changed || reuse.changed;
  steps.push(reuse.status);

  const reuseCall = replaceOnce(
    next,
    "    const canReuseSession = sessionMatches(session, envType, envName, repos);",
    "    const canReuseSession = sessionMatches(session, envType, envName, repos, injectedJwt);",
    "canReuseSession JWT arg",
  );
  next = reuseCall.source;
  changed = changed || reuseCall.changed;
  steps.push(reuseCall.status);

  const persist = replaceOnce(
    next,
    `        const nextSession = {
            cursorAgentId: run.agentId,
            latestRunId: result.id,
            runtime: "cloud",
            envType,
            ...(envName ? { envName } : {}),
            repos,
        };`,
    `        const nextSession = {
            cursorAgentId: run.agentId,
            latestRunId: result.id,
            runtime: "cloud",
            envType,
            ...(envName ? { envName } : {}),
            repos,
            ...(injectedJwt ? { paperclipJwt: true } : {}),
        };`,
    "persist paperclipJwt session flag",
  );
  next = persist.source;
  changed = changed || persist.changed;
  steps.push(persist.status);

  const readSessionFlag = replaceOnce(
    next,
    `        ...(envName ? { envName } : {}),
        repos,
    };
}
function sessionMatches(`,
    `        ...(envName ? { envName } : {}),
        repos,
        ...(record.paperclipJwt === true ? { paperclipJwt: true } : {}),
    };
}
function sessionMatches(`,
    "readSession paperclipJwt",
  );
  next = readSessionFlag.source;
  changed = changed || readSessionFlag.changed;
  steps.push(readSessionFlag.status);

  return { source: next, changed, status: steps.join("; ") };
}

function patchFile(path, patcher) {
  if (!path) return "skip (file missing)";
  const before = readFileSync(path, "utf8");
  const result = patcher(before);
  if (result.changed) writeFileSync(path, result.source);
  return `${path}: ${result.status}`;
}

export function applyPatches(installRoot) {
  const reports = [];
  const registryPath = resolveFirst([
    join(installRoot, "node_modules/@paperclipai/server/dist/adapters/registry.js"),
    join(installRoot, "node_modules/paperclipai/node_modules/@paperclipai/server/dist/adapters/registry.js"),
  ]);
  const executePath = resolveFirst([
    join(installRoot, "node_modules/@paperclipai/adapter-cursor-cloud/dist/server/execute.js"),
    join(installRoot, "node_modules/@paperclipai/server/node_modules/@paperclipai/adapter-cursor-cloud/dist/server/execute.js"),
    join(installRoot, "node_modules/paperclipai/node_modules/@paperclipai/adapter-cursor-cloud/dist/server/execute.js"),
  ]);
  reports.push(patchFile(registryPath, patchRegistrySource));
  reports.push(patchFile(executePath, patchExecuteSource));
  return reports;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const reports = applyPatches(root);
  for (const line of reports) console.log(`   ${line}`);
  if (reports.every((line) => line.startsWith("skip"))) {
    console.log("   cursor_cloud JWT patch: no matching installed files (paperclipai not installed yet)");
  }
}
