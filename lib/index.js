import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir, networkInterfaces } from "node:os";
const name = "dsh-hmos-emulator";
const API_PREFIX = "/dsh-hmos-emulator/api";
const METHODS = /* @__PURE__ */ new Set([
  "toolchain",
  "emu.list",
  "emu.start",
  "emu.stop",
  "devices",
  "scan",
  "project.info",
  "check.lint",
  "lint.notify",
  "deploy",
  "device.ready",
  "deveco.install",
  "deveco.update",
  "screenshot"
]);
const STREAMING_METHODS = /* @__PURE__ */ new Set(["deploy"]);
const IGNORED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  "oh_modules",
  ".git",
  ".hvigor",
  ".idea",
  ".ohpm",
  ".preview",
  ".cxx",
  ".appanalyzer",
  "build"
]);
const PROJECT_MARK = "build-profile.json5";
const OUTPUT_TAIL = 8e4;
function whichFirst(bare) {
  try {
    const probe = process.platform === "win32" ? "where.exe" : "which";
    const out = spawnSync(probe, [bare], { encoding: "utf8", windowsHide: true });
    if (out.status !== 0) return void 0;
    const line = String(out.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
    return line;
  } catch {
    return void 0;
  }
}
function cliUnderNpmRoot(npmRoot) {
  if (!npmRoot) return void 0;
  const cli = join(npmRoot, "node_modules", "@deveco", "deveco-cli", "dist", "cli.js");
  return existsSync(cli) ? cli : void 0;
}
function cliFromWrapper(candidate) {
  if (/\.(c|m)?(js|ts)$/i.test(candidate)) return existsSync(candidate) ? candidate : void 0;
  const dir = dirname(candidate);
  return cliUnderNpmRoot(dir) ?? cliUnderNpmRoot(dirname(dir));
}
function devecoCliHint() {
  const explicit = process.env.DSH_HMOS_DEVECO_CLI || "";
  if (!explicit) return "";
  if (!existsSync(explicit)) return ` \u{1F534} DSH_HMOS_DEVECO_CLI \u6307\u5411\u7684\u8DEF\u5F84\u4E0D\u5B58\u5728,\u5DF2\u5FFD\u7565\u5E76\u56DE\u9000\u81EA\u52A8\u63A2\u6D4B:${explicit}`;
  const traced = cliFromWrapper(explicit);
  if (traced === explicit) return "";
  if (traced) return ` DSH_HMOS_DEVECO_CLI \u6307\u5411\u7684\u662F npm \u5305\u88C5\u811A\u672C(\u57AB\u7247),\u5DF2\u6309\u5B83\u7684\u76EE\u6807\u6539\u7528 JS \u5165\u53E3:${traced}`;
  return ` \u{1F534} DSH_HMOS_DEVECO_CLI \u6307\u5411\u7684\u4E0D\u662F devecocli \u7684 JS \u5165\u53E3(npm \u5305\u88C5\u811A\u672C\u7684\u76EE\u5F55\u4E0B\u4E5F\u6CA1\u6709 node_modules/@deveco/deveco-cli/dist/cli.js),\u5DF2\u5FFD\u7565\u5E76\u56DE\u9000\u81EA\u52A8\u63A2\u6D4B:${explicit}`;
}
function resolveDevecoCli() {
  const explicit = process.env.DSH_HMOS_DEVECO_CLI || "";
  if (explicit && existsSync(explicit)) {
    const traced = cliFromWrapper(explicit);
    if (traced) return traced;
  }
  const shim = whichFirst("devecocli");
  if (shim) {
    const traced = cliFromWrapper(shim);
    if (traced) return traced;
  }
  try {
    const bin = process.platform === "win32" ? "npm.cmd" : "npm";
    const out = spawnSync(bin, ["root", "-g"], { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
    if (out.status === 0) {
      const root = String(out.stdout ?? "").trim();
      const cli = cliUnderNpmRoot(root);
      if (cli) return cli;
    }
  } catch {
  }
  return void 0;
}
function resolveHdc() {
  const suffix = process.platform === "win32" ? "hdc.exe" : "hdc";
  const sdk = process.env.DEVECO_SDK_HOME || "";
  if (sdk) {
    for (const rel of [
      join("default", "openharmony", "toolchains", suffix),
      join("openharmony", "toolchains", suffix)
    ]) {
      const p = join(sdk, rel);
      if (existsSync(p)) return p;
    }
  }
  const found = whichFirst("hdc");
  if (found && existsSync(found)) return found;
  return void 0;
}
function runCli(argv, { cwd, timeoutMs = 12e4 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolvePromise({ code: null, timedOut: false, output: `\u65E0\u6CD5\u542F\u52A8\u8FDB\u7A0B:${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    let out = "";
    const append = (chunk) => {
      out += chunk;
      if (out.length > OUTPUT_TAIL) out = out.slice(out.length - OUTPUT_TAIL);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
      }
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, timedOut, output: `\u8FDB\u7A0B\u542F\u52A8\u5931\u8D25(${error.message});` + (out ? `
${out}` : "") });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = out.trim();
      resolvePromise({ code, timedOut, output: tail.length === 0 ? "(\u65E0\u8F93\u51FA)" : tail });
    });
  });
}
function runCliStream(argv, { cwd, timeoutMs = 12e4, onChunk } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      onChunk?.(`\u65E0\u6CD5\u542F\u52A8\u8FDB\u7A0B:${error instanceof Error ? error.message : String(error)}
`);
      resolvePromise({ code: null, timedOut: false });
      return;
    }
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => onChunk?.(String(chunk)));
    child.stderr?.on("data", (chunk) => onChunk?.(String(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onChunk?.(`\u8FDB\u7A0B\u542F\u52A8\u5931\u8D25(${error.message})
`);
      resolvePromise({ code: null, timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, timedOut });
    });
  });
}
function normalizeDir(input) {
  let dir = input && input.trim() ? resolve(input) : homedir();
  for (let i = 0; i < 6 && !existsSync(dir); i += 1) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return existsSync(dir) && dir !== resolve(dir, sep) ? dir : homedir();
}
function scanProjects(root, maxDepth = 3) {
  if (existsSync(join(root, PROJECT_MARK))) return [root];
  const found = [];
  let queue = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && found.length < 60 && visited < 1200) {
    const next = [];
    for (const { dir, depth } of queue) {
      visited += 1;
      let names = [];
      try {
        names = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of names) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        const child = join(dir, entry.name);
        if (existsSync(join(child, PROJECT_MARK))) {
          found.push(child);
          if (found.length >= 60) break;
        } else if (depth + 1 <= maxDepth) {
          next.push({ dir: child, depth: depth + 1 });
        }
      }
      if (found.length >= 60) break;
    }
    queue = next;
  }
  return found;
}
function stripJson5(text) {
  let out = "";
  let i = 0;
  let quote = "";
  let keyPending = false;
  while (i < text.length) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      keyPending = false;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "{") {
      keyPending = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
      keyPending = true;
      out += ch;
      i += 1;
      continue;
    }
    if (keyPending && /[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k += 1;
      if (text[k] === ":") {
        out += `"${text.slice(i, j)}"`;
        i = j;
        keyPending = false;
        continue;
      }
    }
    if (!/\s/.test(ch)) keyPending = false;
    out += ch;
    i += 1;
  }
  return out;
}
function readModules(project) {
  const file = join(project, PROJECT_MARK);
  if (!existsSync(file)) return [];
  try {
    const cfg = JSON.parse(stripJson5(readFileSync(file, "utf8")));
    const mods = Array.isArray(cfg?.modules) ? cfg.modules : [];
    return mods.map((m) => m && typeof m.name === "string" ? m.name : "").filter(Boolean);
  } catch {
    return [];
  }
}
function projectRootOf(input, exec) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return "";
  return resolve(sessionWorkspace(exec), raw);
}
function readDataUrl(file) {
  try {
    return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}
function parseJsonArray(output) {
  try {
    const arr = JSON.parse(output);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function ensureImageReady(cli, name2) {
  const list = await runCli([process.execPath, cli, "emulator", "list", "--format", "json"], { timeoutMs: 3e4 });
  const inst = list.code === 0 ? parseJsonArray(list.output).find((it) => it && it.name === name2) : void 0;
  const os = inst && typeof inst.osVersion === "string" ? inst.osVersion : "";
  if (!os) return;
  const dt = inst && typeof inst.deviceType === "string" && inst.deviceType ? inst.deviceType : "phone";
  const imgs = await runCli([process.execPath, cli, "emulator", "image", "list", "--all", "--format", "json"], { timeoutMs: 6e4 });
  if (imgs.code !== 0) return;
  const ready = parseJsonArray(imgs.output).some((it) => it && it.osVersion === os && String(it.downloaded).toLowerCase() === "true" && String(it.deviceType || "").toLowerCase() === dt.toLowerCase());
  if (ready) return;
  throw Object.assign(
    new Error(`\u6A21\u62DF\u5668\u300C${name2}\u300D\u7684\u7CFB\u7EDF\u955C\u50CF ${os} \u672A\u4E0B\u8F7D(\u6216\u672A\u88AB devecocli \u8BC6\u522B)\u3002\u8BF7\u5148\u6267\u884C:
  devecocli emulator image download --device-type ${dt} --os-version "${os}"
\u4E0B\u8F7D\u5B8C\u6210\u540E\u518D\u542F\u52A8\u3002`),
    { code: "image-missing" }
  );
}
async function waitDeviceReady(cli, name2, timeoutMs = 12e4, intervalMs = 3e3) {
  const deadline = Date.now() + timeoutMs;
  let serial = null;
  while (Date.now() < deadline) {
    const probe = await runCli([process.execPath, cli, "emulator", "list", "--format", "json"], { timeoutMs: 15e3 });
    if (probe.code === 0) {
      const inst = parseJsonArray(probe.output).find((it) => it && it.name === name2);
      const s = inst && typeof inst.serial === "string" && inst.serial ? inst.serial : null;
      if (s) {
        serial = s;
        const dev = await runCli([process.execPath, cli, "device", "list", "--format", "json"], { timeoutMs: 15e3 });
        const online = dev.code === 0 && parseJsonArray(dev.output).some((x) => (typeof x === "string" ? x : x && (x.serial || x.name)) === s);
        if (online) return { ready: true, serial: s };
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  return { ready: false, serial };
}
let lastLintNotice = "";
let lintNotice = "";
let lintNoticeSession = "";
let lintDeliveries = 0;
function createApi() {
  const api = {};
  api.toolchain = async () => {
    const sdk = process.env.DEVECO_SDK_HOME || "";
    const cliPath = resolveDevecoCli();
    let cliVersion = null;
    if (cliPath) {
      const v = await runCli([process.execPath, cliPath, "--version"], { timeoutMs: 2e4 });
      if (v.code === 0) cliVersion = v.output.trim().split(/\r?\n/)[0] || "" || null;
    }
    const sdkExample = process.platform === "win32" ? "\u5982 C:\\Program Files\\Huawei\\DevEco Studio\\sdk" : "\u6307\u5411\u672C\u673A\u5B89\u88C5\u7684 DevEco Studio SDK \u76EE\u5F55(\u4EE5\u5B9E\u9645\u5B89\u88C5\u4E3A\u51C6)";
    return {
      platform: process.platform,
      home: homedir(),
      node: process.execPath,
      devecoCliJs: cliPath ?? null,
      devecoCliVersion: cliVersion,
      hdcExe: resolveHdc() ?? null,
      sdkHome: sdk || null,
      hint: devecoCliHint() + `devecocli \u7F3A\u5931\u65F6:\u5B89\u88C5 @deveco/deveco-cli \u6216\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF DSH_HMOS_DEVECO_CLI\u3002hdc \u7F3A\u5931\u65F6:\u8BBE\u7F6E DEVECO_SDK_HOME(${sdkExample})\u540E\u91CD\u542F dsh web\u3002` + (process.platform === "linux" ? "Linux \u6A21\u62DF\u5668\u6765\u81EA Command Line Tools(\u9700 26.0.0 Release \u53CA\u4EE5\u4E0A):\u628A DEVECO_CLI_CLT_PATH \u6307\u5411\u5176\u5B89\u88C5\u76EE\u5F55\u3002" : "")
    };
  };
  api["deveco.update"] = async () => {
    const cli = resolveDevecoCli();
    if (!cli) throw Object.assign(new Error("\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)"), { code: "toolchain" });
    const result = await runCli([process.execPath, cli, "update"], { timeoutMs: 24e4 });
    return {
      code: result.code,
      timedOut: result.timedOut,
      output: result.output,
      note: result.code === 0 ? "devecocli \u5DF2\u66F4\u65B0;\u82E5\u5BBF\u4E3B\u7AEF\u8DEF\u5F84\u53D8\u5316,\u5EFA\u8BAE\u91CD\u542F dsh web\u3002" : "\u66F4\u65B0\u5931\u8D25,\u8BF7\u67E5\u770B\u8F93\u51FA(\u53EF\u80FD\u662F npm \u6E90/\u7F51\u7EDC\u95EE\u9898)\u3002"
    };
  };
  api["deveco.install"] = async () => {
    if (process.platform === "win32") {
      const cmd = process.env.ComSpec || "cmd.exe";
      const result2 = await runCli([cmd, "/c", "npm", "install", "-g", "@deveco/deveco-cli"], { timeoutMs: 24e4 });
      return { code: result2.code, timedOut: result2.timedOut, output: result2.output, note: result2.code === 0 ? "devecocli \u5B89\u88C5\u5B8C\u6210,\u8BF7\u91CD\u542F dsh web \u751F\u6548;hdc \u4ECD\u9700\u5B89\u88C5 DevEco Studio SDK \u5E76\u8BBE\u7F6E DEVECO_SDK_HOME\u3002" : "\u5B89\u88C5\u5931\u8D25,\u8BF7\u67E5\u770B\u8F93\u51FA;\u4E5F\u53EF\u80FD\u662F npm \u6E90/\u6743\u9650\u95EE\u9898\u3002" };
    }
    const result = await runCli(["npm", "install", "-g", "@deveco/deveco-cli"], { timeoutMs: 24e4 });
    return { code: result.code, timedOut: result.timedOut, output: result.output, note: result.code === 0 ? "devecocli \u5B89\u88C5\u5B8C\u6210,\u8BF7\u91CD\u542F dsh web \u751F\u6548;hdc \u4ECD\u9700\u5B89\u88C5 DevEco Studio SDK \u5E76\u8BBE\u7F6E DEVECO_SDK_HOME\u3002" : "\u5B89\u88C5\u5931\u8D25,\u8BF7\u67E5\u770B\u8F93\u51FA;\u4E5F\u53EF\u80FD\u662F npm \u6E90/\u6743\u9650\u95EE\u9898\u3002" };
  };
  api["emu.list"] = async () => {
    const cli = resolveDevecoCli();
    if (!cli) throw Object.assign(new Error("\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)"), { code: "toolchain" });
    const result = await runCli([process.execPath, cli, "emulator", "list", "--format", "json"], { timeoutMs: 6e4 });
    let instances = [];
    let parseError = null;
    if (result.code === 0) {
      const start = result.output.indexOf("[");
      const end = result.output.lastIndexOf("]");
      if (start >= 0 && end > start) {
        try {
          const arr = JSON.parse(result.output.slice(start, end + 1));
          if (Array.isArray(arr)) {
            instances = arr.map((item) => ({
              name: typeof item?.name === "string" ? item.name : "",
              status: typeof item?.status === "string" ? item.status : "",
              serial: item?.serial ?? null,
              deviceType: typeof item?.deviceType === "string" ? item.deviceType : "",
              osVersion: typeof item?.osVersion === "string" ? item.osVersion : ""
            })).filter((it) => it.name !== "");
          }
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    return { code: result.code, timedOut: result.timedOut, instances, parseError, raw: result.output };
  };
  api["emu.start"] = async (payload) => {
    const cli = resolveDevecoCli();
    if (!cli) throw Object.assign(new Error("\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)"), { code: "toolchain" });
    const name2 = typeof payload?.name === "string" && payload.name.trim() ? payload.name.trim() : null;
    if (!name2) throw Object.assign(new Error("\u7F3A\u5C11\u6A21\u62DF\u5668\u5B9E\u4F8B\u540D(\u5148\u6267\u884C\u201C\u5217\u51FA\u6A21\u62DF\u5668\u201D\u67E5\u770B\u5B9E\u4F8B\u540D)"), { code: "bad-request" });
    await ensureImageReady(cli, name2);
    const result = await runCli([process.execPath, cli, "emulator", "start", name2], { timeoutMs: 24e4 });
    if (result.code !== 0) return { code: result.code, timedOut: result.timedOut, output: result.output, ready: false, serial: null };
    const { ready, serial } = await waitDeviceReady(cli, name2);
    return { code: result.code, timedOut: result.timedOut, output: result.output, ready, serial };
  };
  api["emu.stop"] = async (payload) => {
    const cli = resolveDevecoCli();
    if (!cli) throw Object.assign(new Error("\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)"), { code: "toolchain" });
    const target = typeof payload?.target === "string" && payload.target.trim() ? payload.target.trim() : null;
    if (!target) throw Object.assign(new Error("\u7F3A\u5C11\u8981\u505C\u6B62\u7684\u6A21\u62DF\u5668\u540D\u79F0\u6216\u4E32\u53F7"), { code: "bad-request" });
    const result = await runCli([process.execPath, cli, "emulator", "stop", target], { timeoutMs: 6e4 });
    return { code: result.code, timedOut: result.timedOut, output: result.output };
  };
  api.devices = async () => {
    const cli = resolveDevecoCli();
    const devices = [];
    let raw = "";
    let error = null;
    if (cli) {
      const result = await runCli([process.execPath, cli, "device", "list", "--format", "json"], { timeoutMs: 3e4 });
      raw = result.output;
      if (result.code === 0) {
        try {
          const arr = JSON.parse(result.output);
          if (Array.isArray(arr)) {
            for (const d of arr) {
              const serial = typeof d === "string" ? d : d && (d.serial || d.name);
              if (typeof serial === "string" && /^[\w.:-]+$/.test(serial)) devices.push(serial);
            }
          }
        } catch (e) {
          error = `device list \u89E3\u6790\u5931\u8D25:${e instanceof Error ? e.message : String(e)}`;
        }
      } else {
        error = raw;
      }
    } else {
      error = "\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)";
    }
    return { devices, raw, hdcError: error, hdcExe: resolveHdc() ?? null };
  };
  api.scan = async (payload) => {
    const root = normalizeDir(payload?.root);
    const paths = scanProjects(root);
    return { root, projects: paths };
  };
  api["project.info"] = async (payload) => {
    const project = typeof payload?.projectPath === "string" ? resolve(payload.projectPath) : "";
    if (!project || !existsSync(project)) throw Object.assign(new Error("\u5E94\u7528\u5DE5\u7A0B\u8DEF\u5F84\u4E0D\u5B58\u5728"), { code: "bad-request" });
    return { isProject: existsSync(join(project, PROJECT_MARK)), modules: readModules(project) };
  };
  api["check.lint"] = async (payload) => {
    const project = typeof payload?.projectPath === "string" ? resolve(payload.projectPath) : "";
    if (!project || !existsSync(project)) throw Object.assign(new Error("\u5E94\u7528\u5DE5\u7A0B\u8DEF\u5F84\u4E0D\u5B58\u5728"), { code: "bad-request" });
    const asked = payload?.mode;
    const fixing = asked === "fix" || asked === "fix-all";
    if (fixing && !existsSync(join(project, PROJECT_MARK))) {
      throw Object.assign(new Error(`\u201C${project}\u201D\u4E0D\u662F\u9E3F\u8499\u5DE5\u7A0B\u6839(\u7F3A\u5C11 ${PROJECT_MARK}),\u4E0D\u80FD\u6267\u884C\u81EA\u52A8\u4FEE\u590D`), { code: "bad-request" });
    }
    const cli = resolveDevecoCli();
    if (!cli) throw Object.assign(new Error("\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)"), { code: "toolchain" });
    const full = asked === "all" || asked === "fix-all";
    const mode = full ? fixing ? "fix-all" : "all" : fixing ? "fix" : "changed";
    const scopeMode = full ? "all" : "changed";
    const timeoutMs = full ? 6e5 : 3e5;
    const argv = [process.execPath, cli, "check", "lint", project];
    if (!full) argv.push("--incremental");
    if (fixing) argv.push("--fix");
    const before = fixing ? await hashTree(project) : null;
    const fixRun = await runCli(argv, { timeoutMs });
    const check = fixing ? await runCli(argv.filter((a) => a !== "--fix"), { timeoutMs }) : fixRun;
    const text = check.output;
    const summary = parseLintSummary(text);
    const hasProblems = summary !== null && (summary.errors > 0 || summary.warnings > 0 || summary.suggestions > 0);
    const changedFiles = summary !== null && summary.files === 0 && !full ? await countChangedCode(project) : null;
    const outcome = lintOutcome(summary, scopeMode, changedFiles);
    let stats = outcome.stats;
    if (fixing) {
      let fixedFiles = null;
      if (before !== null) {
        const after = await hashTree(project);
        if (after !== null) {
          fixedFiles = 0;
          for (const [path, hash] of after) if (before.get(path) !== hash) fixedFiles += 1;
          for (const path of before.keys()) if (!after.has(path)) fixedFiles += 1;
        }
      }
      stats = `${fixStats(fixedFiles)};${outcome.stats === "\u672A\u53D1\u73B0\u544A\u8B66" ? "\u590D\u68C0\u672A\u53D1\u73B0\u544A\u8B66" : `\u590D\u68C0 \u2014 ${outcome.stats}`}`;
    }
    const modeLabel = LINT_LABELS[mode];
    const excerpt = hasProblems ? headText(text, 30) : tailText(text, 2);
    const forModel = outcome.empty ? "" : hasProblems ? headText(text, 12) : tailText(text, 1);
    const clipped = forModel.length > 1500 ? `${forModel.slice(0, 1500)}
\u2026(\u5DF2\u622A\u65AD;\u9700\u8981\u5168\u90E8\u95EE\u9898\u65F6\u518D\u8DD1\u4E00\u6B21\u68C0\u67E5)` : forModel;
    lastLintNotice = `[\u4EE3\u7801\u68C0\u67E5] ${modeLabel} ${project} \u2014 ${stats}${clipped ? `
${clipped}` : ""}`;
    return {
      ok: check.code === 0,
      code: check.code,
      timedOut: fixRun.timedOut || check.timedOut,
      summary,
      empty: outcome.empty,
      stats,
      text: excerpt
    };
  };
  api["lint.notify"] = async (payload) => {
    if (!lastLintNotice) throw Object.assign(new Error("\u5C1A\u672A\u751F\u6210\u68C0\u67E5\u7ED3\u679C,\u8BF7\u5148\u6267\u884C\u4EE3\u7801\u68C0\u67E5"), { code: "bad-request" });
    lintNotice = lastLintNotice;
    lintNoticeSession = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    lintDeliveries = 0;
    return { sent: true, bytes: lintNotice.length };
  };
  api.deploy = async (payload, res) => {
    const cli = resolveDevecoCli();
    if (!cli) throw Object.assign(new Error("\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)"), { code: "toolchain" });
    const project = typeof payload?.projectPath === "string" ? resolve(payload.projectPath) : "";
    if (!project || !existsSync(project)) throw Object.assign(new Error("\u5E94\u7528\u5DE5\u7A0B\u8DEF\u5F84\u4E0D\u5B58\u5728"), { code: "bad-request" });
    if (!existsSync(join(project, PROJECT_MARK))) {
      throw Object.assign(new Error(`\u201C${project}\u201D\u4E0D\u662F\u9E3F\u8499\u5DE5\u7A0B\u6839(\u7F3A\u5C11 ${PROJECT_MARK})`), { code: "bad-request" });
    }
    const device = typeof payload?.device === "string" && payload.device.trim() ? payload.device.trim() : null;
    if (!device) throw Object.assign(new Error("\u8BF7\u5148\u201C\u5237\u65B0\u8BBE\u5907\u201D\u5E76\u9009\u62E9\u4E00\u4E2A\u6A21\u62DF\u5668\u8BBE\u5907"), { code: "bad-request" });
    if (cli) {
      const probe = await runCli([process.execPath, cli, "device", "list", "--format", "json"], { timeoutMs: 15e3 });
      let online = false;
      if (probe.code === 0) {
        try {
          const arr = JSON.parse(probe.output);
          online = Array.isArray(arr) && arr.some((d) => {
            const s = typeof d === "string" ? d : d && (d.serial || d.name);
            return s === device;
          });
        } catch {
        }
      }
      if (!online) {
        throw Object.assign(new Error(`\u8BBE\u5907 ${device} \u5F53\u524D\u672A\u5728\u7EBF\u2014\u2014\u8BF7\u5148\u70B9\u201C\u542F\u52A8\u201D\u6A21\u62DF\u5668(\u6216\u8FDE\u63A5\u8BBE\u5907),\u518D\u70B9\u201C\u626B\u63CF\u53EF\u7528\u201D\u540E\u91CD\u8BD5`), { code: "device-offline" });
      }
    }
    const modules = readModules(project);
    if (payload?.module !== void 0 && payload?.module !== null && !modules.includes(String(payload.module))) {
      throw Object.assign(new Error(`\u6A21\u5757\u201C${payload.module}\u201D\u4E0D\u5C5E\u4E8E\u8BE5\u5DE5\u7A0B(\u53EF\u9009:${modules.join("\u3001") || "\u65E0"})`), { code: "bad-request" });
    }
    const chosen = payload?.module ? String(payload.module) : modules.includes("entry") ? "entry" : modules[0];
    const cmd = [process.execPath, cli, "run", "--device", device];
    if (chosen) cmd.push("--module", chosen);
    const note = (code) => code === 0 ? "\u6784\u5EFA\u3001\u5B89\u88C5\u3001\u542F\u52A8\u5B8C\u6210\u3002(hvigor \u7684 \u201CNo signingConfigs\u201D \u53EA\u662F\u8B66\u544A,\u6A21\u62DF\u5668\u53EF\u88C5\u672A\u7B7E\u540D debug \u5305)" : "\u90E8\u7F72\u5931\u8D25,\u8BF7\u67E5\u770B\u4E0A\u65B9\u8F93\u51FA;\u5E38\u89C1\u539F\u56E0:\u7B7E\u540D\u672A\u914D\u7F6E / \u8BBE\u5907\u672A\u5C31\u7EEA\u3002";
    if (res && typeof res.write === "function") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache, no-transform" });
      res.write(`[dsh-hmos-emulator] \u90E8\u7F72 ${device}${chosen ? `(\u6A21\u5757 ${chosen})` : ""}
`);
      const { code } = await runCliStream(cmd, {
        cwd: project,
        timeoutMs: 20 * 60 * 1e3,
        onChunk: (chunk) => {
          try {
            res.write(chunk);
          } catch {
          }
        }
      });
      res.write(`
${note(code)}
`);
      res.write(`[HMOS_EXIT]=${code ?? -1}
`);
      res.end();
      return;
    }
    const result = await runCli(cmd, { cwd: project, timeoutMs: 20 * 60 * 1e3 });
    return { code: result.code, timedOut: result.timedOut, output: result.output, note: note(result.code) };
  };
  api["device.ready"] = async (payload) => {
    const cli = resolveDevecoCli();
    if (!cli) throw Object.assign(new Error("\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)"), { code: "toolchain" });
    const serial = typeof payload?.serial === "string" && payload.serial.trim() ? payload.serial.trim() : null;
    if (!serial) throw Object.assign(new Error("\u7F3A\u5C11\u8BBE\u5907\u4E32\u53F7"), { code: "bad-request" });
    const probe = await runCli([process.execPath, cli, "device", "list", "--format", "json"], { timeoutMs: 15e3 });
    let devices = [];
    let online = false;
    if (probe.code === 0) {
      try {
        const arr = JSON.parse(probe.output);
        devices = (Array.isArray(arr) ? arr : []).map((d) => typeof d === "string" ? d : d && (d.serial || d.name)).filter((s) => typeof s === "string" && /^[\w.:-]+$/.test(s));
        online = devices.includes(serial);
      } catch {
      }
    }
    return { online, serial, devices };
  };
  api.screenshot = async (payload) => {
    const cli = resolveDevecoCli();
    if (!cli) throw Object.assign(new Error("\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)"), { code: "toolchain" });
    const device = typeof payload?.device === "string" && payload.device.trim() ? payload.device.trim() : null;
    if (!device) throw Object.assign(new Error("\u7F3A\u5C11\u76EE\u6807\u8BBE\u5907\u4E32\u53F7(\u5148\u201C\u5237\u65B0\u8BBE\u5907\u201D\u5E76\u9009\u62E9)"), { code: "bad-request" });
    const root = typeof payload?.root === "string" && payload.root.trim() ? payload.root.trim() : null;
    if (!root || !existsSync(root)) throw Object.assign(new Error("\u7F3A\u5C11\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55(\u622A\u56FE\u5B58\u653E\u4E8E <\u6839>/screenshots)"), { code: "bad-request" });
    const dir = join(root, "screenshots");
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw Object.assign(new Error(`\u65E0\u6CD5\u521B\u5EFA\u622A\u56FE\u76EE\u5F55 ${dir}:${error instanceof Error ? error.message : String(error)}`), { code: "fs-error" });
    }
    const safe = device.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 24);
    const auto = payload?.auto === true;
    const tool = !auto && payload?.origin === "tool";
    const label = String(payload?.label ?? "shot").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "shot";
    const file = join(dir, auto ? `${AUTO_SHOT_PREFIX}${label}-${Date.now()}-${safe}.png` : tool ? `${TOOL_SHOT_PREFIX}${Date.now()}-${safe}.png` : `hmos-shot-${Date.now()}-${safe}.png`);
    const result = await runCli([process.execPath, cli, "ui", "screenshot", "--device", device, "--path", file], { timeoutMs: 6e4 });
    if (result.code !== 0 || !existsSync(file)) {
      const why = result.timedOut ? "\u8D85\u65F6" : result.code === 0 ? "\u672A\u751F\u6210\u6587\u4EF6" : `\u9000\u51FA\u7801 ${result.code}`;
      throw new Error(`\u622A\u56FE\u5931\u8D25(${why}):
${result.output}`);
    }
    if (auto) pruneAutoShots(dir);
    else if (tool) pruneToolShots(dir);
    return { path: file, device, dataUrl: payload?.preview ? readDataUrl(file) : null };
  };
  return api;
}
const MAX_BODY_BYTES = 1e6;
function headerValue(headers, name2) {
  const value = headers?.[name2];
  return typeof value === "string" ? value : void 0;
}
function parseAuthority(authority) {
  if (authority === void 0 || authority === "") return void 0;
  try {
    return new URL(`http://${authority}`);
  } catch {
    return void 0;
  }
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function trustRequest(req, trustedHosts = []) {
  const hostUrl = parseAuthority(headerValue(req?.headers, "host"));
  if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname)) {
    const declared = trustedHosts.some((entry) => {
      const entryUrl = parseAuthority(entry);
      if (entryUrl === void 0) return false;
      return entryUrl.port === "" ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
    });
    if (!declared) return false;
  }
  if (headerValue(req?.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = headerValue(req?.headers, "origin");
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
function fenceAuthorities(webRuntime, bindHost) {
  const published = webRuntime?.trustedHosts;
  if (Array.isArray(published)) {
    return published.filter((entry) => typeof entry === "string" && entry.trim() !== "");
  }
  if (bindHost !== "0.0.0.0") return [];
  return Object.values(networkInterfaces()).flat().filter((iface) => iface !== void 0 && iface.family === "IPv4" && !iface.internal).map((iface) => String(iface?.address ?? "")).filter((address) => address !== "");
}
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        rejectBody(Object.assign(new Error(`\u8BF7\u6C42\u4F53\u8FC7\u5927(\u4E0A\u9650 ${MAX_BODY_BYTES} \u5B57\u8282)`), { code: "too-large" }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    });
  });
}
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}
function writeError(res, error) {
  const code = error && error.code ? error.code : "internal";
  const message = error instanceof Error ? error.message : String(error);
  const status = code === "too-large" ? 413 : code === "bad-request" || code === "toolchain" || code === "fs-error" || code === "image-missing" ? 400 : 500;
  writeJson(res, status, { ok: false, error: { code, message } });
}
const TOOL_OUT_SCHEMA = { type: "object", additionalProperties: true };
function imageBlockOf(image) {
  if (!image || typeof image !== "object" || Array.isArray(image)) return void 0;
  if (typeof image.attachmentId !== "string" || typeof image.mediaType !== "string") return void 0;
  return { type: "image", attachment: { ...image } };
}
const toolRender = (_args, value) => {
  const blocks = [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  const block = imageBlockOf(record?.image) ?? imageBlockOf(record?.last?.image);
  if (block) blocks.push(block);
  return blocks;
};
async function attachmentRefForImage(ctx, filePath) {
  try {
    const attachments = ctx && typeof ctx.get === "function" ? ctx.get("attachments") : void 0;
    if (!attachments || typeof attachments.saveImage !== "function") return void 0;
    const ref = await attachments.saveImage({ data: readFileSync(filePath), mediaType: "image/png", name: basename(filePath) });
    if (!ref || typeof ref.attachmentId !== "string") return void 0;
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: String(ref.mediaType || "image/png"),
      bytes: Number(ref.bytes) || 0,
      width: Number(ref.width) || 0,
      height: Number(ref.height) || 0,
      ...typeof ref.name === "string" ? { name: ref.name } : {}
    };
  } catch {
    return void 0;
  }
}
function headText(text, n) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(0, n).join("\n");
}
function tailText(text, n) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(-n).join("\n");
}
async function changedCodeFiles(project) {
  return (await codeStatusFiles(project))?.changed ?? null;
}
async function untrackedCodeFiles(project) {
  return (await codeStatusFiles(project))?.untracked ?? null;
}
async function codeStatusFiles(project) {
  const status = await runCli(["git", "-c", "core.quotepath=false", "status", "--porcelain", "--", "."], { cwd: project, timeoutMs: 15e3 });
  if (status.code !== 0) return null;
  const top = await runCli(["git", "rev-parse", "--show-toplevel"], { cwd: project, timeoutMs: 15e3 });
  const root = top.code === 0 ? top.output.split(/\r?\n/)[0].trim().replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const changed = [];
  const untracked = [];
  for (const line of status.output.split(/\r?\n/)) {
    const parsed = /^\s*([A-Z?!]{1,2})\s+(.+)$/.exec(line);
    if (!parsed) continue;
    const rest = parsed[2].trim();
    const raw = rest.includes(" -> ") ? rest.slice(rest.lastIndexOf(" -> ") + 4) : rest;
    const path = raw.replace(/^"(.*)"$/, "$1");
    const full = root ? relativeTo(project, join(root, path)) : path;
    if (!/\.(ets|ts|js)$/.test(full)) continue;
    if (parsed[1].includes("?")) untracked.push(full);
    else changed.push(full);
  }
  return { changed, untracked };
}
function lintScope(requested, changed) {
  if (requested === "all") return { full: true, escalated: false, checkedFiles: null };
  if (changed === null) return { full: true, escalated: true, checkedFiles: null };
  return { full: false, escalated: false, checkedFiles: changed };
}
async function countChangedCode(project) {
  const files = await changedCodeFiles(project);
  return files === null ? null : files.length;
}
function lintOutcome(summary, mode, changedFiles) {
  if (summary === null) return { empty: false, stats: "\u672A\u89E3\u6790\u5230\u7ED3\u679C" };
  const scoped = mode === "changed" || mode === "fix";
  if (scoped && summary.files === 0) {
    if (changedFiles === 0) return { empty: true, stats: "\u65E0 Git \u5DF2\u8DDF\u8E2A\u6539\u52A8,\u672A\u68C0\u67E5\u4EFB\u4F55\u6587\u4EF6" };
    if (typeof changedFiles === "number") return { empty: false, stats: `\u672A\u53D1\u73B0\u544A\u8B66(\u5DF2\u68C0\u67E5 ${changedFiles} \u4E2A\u6539\u52A8\u6587\u4EF6)` };
    return { empty: false, stats: "\u672A\u53D1\u73B0\u544A\u8B66(\u4EC5\u68C0\u67E5\u672A\u63D0\u4EA4\u6539\u52A8)" };
  }
  if (summary.errors + summary.warnings + summary.suggestions === 0) return { empty: false, stats: "\u672A\u53D1\u73B0\u544A\u8B66" };
  return { empty: false, stats: `\u9519\u8BEF ${summary.errors} / \u8B66\u544A ${summary.warnings} / \u5EFA\u8BAE ${summary.suggestions} / \u6D89\u53CA\u6587\u4EF6 ${summary.files}` };
}
const LINT_LABELS = { changed: "\u68C0\u67E5\u6539\u52A8", all: "\u5168\u91CF\u68C0\u67E5", fix: "\u81EA\u52A8\u4FEE\u590D", "fix-all": "\u5168\u91CF\u4FEE\u590D" };
const LINT_EXT = /\.(ets|ts|js|json5|json)$/;
const LINT_SKIP = /(^|[\\/])(node_modules|oh_modules|build|\.git|\.hvigor|\.idea|\.preview)([\\/]|$)/;
async function hashTree(root) {
  const out = /* @__PURE__ */ new Map();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (LINT_SKIP.test(full)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (LINT_EXT.test(entry.name)) out.set(full, createHash("sha1").update(await readFile(full)).digest("hex"));
    }
  };
  try {
    await walk(root);
    return out;
  } catch {
    return null;
  }
}
function fixStats(fixedFiles) {
  if (fixedFiles === null) return "\u5DF2\u6267\u884C\u81EA\u52A8\u4FEE\u590D(\u65E0\u6CD5\u7EDF\u8BA1\u6539\u52A8\u6587\u4EF6)";
  if (fixedFiles === 0) return "\u6CA1\u6709\u53EF\u81EA\u52A8\u4FEE\u590D\u7684\u544A\u8B66,\u672A\u6539\u52A8\u4EFB\u4F55\u6587\u4EF6";
  return `\u5DF2\u81EA\u52A8\u4FEE\u590D ${fixedFiles} \u4E2A\u6587\u4EF6`;
}
const LINT_SUMMARY_RE = /Issues:\s*(\d+)\s*\|\s*Errors:\s*(\d+)\s*\|\s*Warnings:\s*(\d+)\s*\|\s*Suggestions:\s*(\d+)\s*\|\s*Files checked:\s*(\d+)/;
function parseLintSummary(text) {
  const m = String(text || "").match(LINT_SUMMARY_RE);
  return m ? { issues: Number(m[1]), errors: Number(m[2]), warnings: Number(m[3]), suggestions: Number(m[4]), files: Number(m[5]) } : null;
}
async function firstRunningSerial(cli) {
  const r = await runCli([process.execPath, cli, "emulator", "list", "--format", "json"], { timeoutMs: 2e4 });
  const inst = parseJsonArray(r.output).find((it) => it && typeof it.serial === "string" && it.serial && /running/i.test(String(it.status)));
  return inst ? inst.serial : "";
}
function cleanLayout(text) {
  return String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "" && !/Dumping layout/i.test(l)).join("\n");
}
function capLines(lines, max = 80) {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `\u2026(\u8FD8\u6709 ${lines.length - max} \u884C\u672A\u663E\u793A;\u53EF\u7528 depth \u6216 filter \u6536\u7A84)`];
}
function parseLayoutLine(raw) {
  const text = raw.match(/"((?:[^"\\]|\\.)*)"/);
  let decoded = "";
  if (text) {
    try {
      decoded = JSON.parse(`"${text[1]}"`);
    } catch {
      decoded = text[1];
    }
  }
  const box = raw.match(/\[(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/);
  const bounds = box ? [Number(box[1]), Number(box[2]), Number(box[3]), Number(box[4])] : null;
  const head = raw.trim().match(/^([A-Za-z_][\w.]*)/);
  return {
    type: head ? head[1] : "",
    text: decoded,
    bounds,
    area: bounds ? Math.abs((bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) : Number.MAX_SAFE_INTEGER,
    clickable: /\bclickable\b/.test(raw),
    indent: raw.length - raw.trimStart().length,
    raw
  };
}
function tapTarget(lines, index) {
  const hit = lines[index];
  if (hit.clickable) return hit;
  let depth = hit.indent;
  for (let i = index - 1; i >= 0; i--) {
    if (lines[i].indent >= depth) continue;
    if (lines[i].clickable) {
      return hit.area === 0 || lines[i].area <= hit.area * 64 ? lines[i] : hit;
    }
    depth = lines[i].indent;
  }
  return hit;
}
function tapPoint(target, screenBottom) {
  const [x1, y1, x2, y2] = target.bounds;
  const x = Math.round((x1 + x2) / 2);
  const y = Math.round((y1 + y2) / 2);
  return screenBottom > 0 && y > screenBottom * 0.95 ? { x, y: Math.round(y1 + (y2 - y1) / 6) } : { x, y };
}
function labelMatches(lines, label) {
  const wanted = String(label ?? "");
  if (!wanted) return [];
  const hits = lines.map((_, i) => i).filter((i) => lines[i].bounds && lines[i].text.includes(wanted));
  if (!hits.length) return [];
  const rank = (i) => (lines[i].text === wanted ? 0 : 1) * 2 + (lines[i].clickable ? 0 : 1);
  hits.sort((a, b) => rank(a) - rank(b) || lines[a].area - lines[b].area);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const i of hits) {
    const target = tapTarget(lines, i);
    const targetIndex = lines.indexOf(target);
    if (seen.has(targetIndex)) continue;
    seen.add(targetIndex);
    out.push({ id: i, line: lines[i], target, targetIndex, exact: lines[i].text === wanted });
  }
  return out;
}
function candidateList(lines, matches, cap = 5) {
  return matches.slice(0, cap).map((m, index) => {
    const label = nodeLabel(lines, m.id) || nodeLabel(lines, m.targetIndex);
    const at = ancestorLabels(lines, m.targetIndex).find((text) => text !== label) ?? "";
    return { index, label, ...at ? { at } : {}, bounds: m.target.bounds };
  });
}
function selectLayoutLines(lines, query = {}) {
  let re = null;
  if (typeof query?.textRegex === "string" && query.textRegex) {
    try {
      re = new RegExp(query.textRegex);
    } catch {
      re = null;
    }
  }
  const wanted = typeof query?.type === "string" ? query.type.toLowerCase() : "";
  const picked = lines.map((line, index) => ({ index, line })).filter(({ line }) => {
    if (wanted && line.type.toLowerCase() !== wanted) return false;
    if (re && !re.test(line.text)) return false;
    return true;
  });
  if (!query?.clickableOnly) return picked;
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const { index, line } of picked) {
    if (line.clickable) {
      if (!seen.has(index)) {
        seen.add(index);
        out.push({ index, line });
      }
      continue;
    }
    const target = tapTarget(lines, index);
    const targetIndex = target && target.clickable ? lines.indexOf(target) : -1;
    if (targetIndex < 0 || seen.has(targetIndex)) continue;
    seen.add(targetIndex);
    out.push({ index: targetIndex, line: lines[targetIndex] });
  }
  return out;
}
function renderLines(rows) {
  return rows.map(({ index, line }) => `${" ".repeat(line.indent)}#${index} ${line.raw.trim()}`);
}
function renderLayout(rows) {
  return capLines(renderLines(rows)).join("\n");
}
function rawKeys(rows) {
  return rows.map(({ line }) => line.raw.trim());
}
function diffLines(before, after) {
  const counts = /* @__PURE__ */ new Map();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added = [];
  for (const line of after) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added.push(line);
  }
  const removed = [];
  for (const [line, left] of counts) for (let i = 0; i < left; i += 1) removed.push(line);
  if (added.length === 0 && removed.length === 0) return "changed:0";
  return [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join("\n");
}
function nodeLabel(lines, index) {
  const own = lines[index] ? lines[index].text : "";
  if (own) return own;
  const indent = lines[index] ? lines[index].indent : 0;
  for (let i = index + 1; i < lines.length; i += 1) {
    if (lines[i].indent <= indent) break;
    if (lines[i].text) return lines[i].text;
  }
  return "";
}
function ancestorLabels(lines, index, limit = 3) {
  const chain = [];
  const own = nodeLabel(lines, index);
  if (own) chain.push(own);
  const refArea = lines[index] ? lines[index].area : 0;
  let indent = lines[index] ? lines[index].indent : 0;
  for (let i = index - 1; i >= 0 && chain.length < limit; i -= 1) {
    if (lines[i].indent >= indent) continue;
    if (refArea > 0 && lines[i].area > refArea * 64) break;
    indent = lines[i].indent;
    const label = nodeLabel(lines, i);
    if (label && label !== chain[chain.length - 1]) chain.push(label);
  }
  return chain.reverse();
}
function pageTitle(lines) {
  const navIndex = lines.findIndex((l) => l.type.toLowerCase() === "navdestination");
  if (navIndex >= 0) {
    const indent = lines[navIndex].indent;
    let shallowest = Number.MAX_SAFE_INTEGER;
    let found = "";
    for (let i = navIndex + 1; i < lines.length; i += 1) {
      if (lines[i].indent <= indent) break;
      if (lines[i].text && lines[i].indent < shallowest) {
        shallowest = lines[i].indent;
        found = lines[i].text;
      }
    }
    if (found) return found;
  }
  const bottom = lines.reduce((max, l) => l.bounds ? Math.max(max, l.bounds[3]) : max, 0);
  const band = bottom * 0.2;
  const first = lines.find((l) => l.text && l.bounds && l.bounds[1] < band && !/^\d+$/.test(l.text.trim()));
  return first && first.indent <= 2 ? first.text : "";
}
function layoutJson(rows, lines = []) {
  return rows.map(({ index, line }) => {
    const label = lines.length > 0 ? nodeLabel(lines, index) : line.text;
    return {
      id: index,
      type: line.type,
      bounds: line.bounds,
      depth: Math.floor(line.indent / 2),
      clickable: line.clickable,
      ...line.text ? { text: line.text } : {},
      // An inherited label (the text lives in a child) is what tells the caller what it matched.
      ...label && label !== line.text ? { label } : {}
    };
  });
}
function pointOf(lines, index) {
  const line = lines[index];
  if (!line || !line.bounds) return null;
  const screenBottom = Math.max(...lines.map((l) => l.bounds ? l.bounds[3] : 0));
  return tapPoint(tapTarget(lines, index), screenBottom);
}
function matchLayout(lines, { text, textRegex, clickableOnly } = {}) {
  const wanted = typeof text === "string" ? text : "";
  let re = null;
  if (typeof textRegex === "string" && textRegex) {
    try {
      re = new RegExp(textRegex);
    } catch {
      re = null;
    }
  }
  if (!wanted && !re) return [];
  const hits = [];
  lines.forEach((line, index) => {
    if (!line.bounds) return;
    if (clickableOnly && !line.clickable) return;
    const hit = wanted && line.text.includes(wanted) || (re ? re.test(line.text) : false);
    if (!hit) return;
    const point = pointOf(lines, index);
    if (point) hits.push({ id: index, x: point.x, y: point.y, text: line.text });
  });
  return hits;
}
function parseLintTable(text) {
  const findings = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d+)\s{2,}(.+?)\s{2,}(\d+)\s{2,}(\d+)\s{2,}(Error|Warning|Suggestion)\s{2,}(\S+)\s{2,}(.*)$/);
    if (!m) continue;
    findings.push({ file: m[2].trim(), line: Number(m[3]), column: Number(m[4]), severity: m[5], rule: m[6], message: m[7].trim() });
  }
  return { findings, summary: parseLintSummary(text) };
}
function parseBuildErrors(text) {
  const src = String(text || "");
  const errors = [];
  const re = /\d+\s+ERROR:\s*(\d+)?\s*[^\n]*\nError Message:\s*([\s\S]*?)\s*At [Ff]ile:\s*([^\n]*?):(\d+)(?::(\d+))?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    errors.push({
      file: m[3].trim(),
      line: Number(m[4]),
      column: m[5] ? Number(m[5]) : 0,
      code: (m[1] || "").trim(),
      message: m[2].replace(/\s+/g, " ").trim()
    });
  }
  const counts = src.match(/COMPILE RESULT:\w*\s*\{ERROR:(\d+)\s+WARN:(\d+)\}/);
  return { errors, errorCount: counts ? Number(counts[1]) : errors.length, warnCount: counts ? Number(counts[2]) : 0 };
}
function relativeTo(root, file) {
  const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const f = norm(file);
  return r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f;
}
function deployPhase(text) {
  const src = String(text || "");
  if (/Launching\s+\S+/.test(src)) return "launch";
  if (/Installing artifacts/.test(src)) return "install";
  return "build";
}
function hapPathOf(project, module) {
  const dir = join(project, module, "build", "default", "outputs", "default");
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".hap"));
    let best = "";
    let bestMs = -1;
    for (const f of files) {
      const ms = statSync(join(dir, f)).mtimeMs;
      if (ms > bestMs) {
        bestMs = ms;
        best = f;
      }
    }
    return best ? join(dir, best) : null;
  } catch {
    return null;
  }
}
function parseLogLines(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([DIWEF])\s+(\S+?):\s?(.*)$/);
    if (!m) continue;
    const domainTag = m[5];
    out.push({
      time: m[1],
      level: m[4],
      tag: domainTag.includes("/") ? domainTag.slice(domainTag.lastIndexOf("/") + 1) : domainTag,
      message: m[6].trim()
    });
  }
  return out;
}
function stepSummary(action, value) {
  if (value === null || typeof value !== "object") return String(value ?? "");
  if (value.ok !== true) return String(value.error ?? value.reason ?? "\u5931\u8D25").replace(/\s+/g, " ").slice(0, 160);
  const bits = [];
  if (value.page) bits.push(`page=${value.page}`);
  if (Number.isFinite(value.total)) bits.push(`${value.total} \u8282\u70B9`);
  if (Array.isArray(value.ancestors) && value.ancestors.length > 0) bits.push(value.ancestors.join("/"));
  if (Number.isFinite(value.matchCount) && value.matchCount > 1) bits.push(`match=${value.matchCount}`);
  if (Number.isFinite(value.x)) bits.push(`(${value.x},${value.y})`);
  if (Array.isArray(value.matched)) bits.push(`matched=${value.matched.length}`);
  if (typeof value.tree === "string" && value.tree) bits.push(value.tree.replace(/\s*\n\s*/g, " | ").slice(0, 160));
  return bits.join(" ") || `${action} ok`;
}
function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd.trim() : process.cwd();
}
const AUTO_SHOT_PREFIX = "auto-";
const TOOL_SHOT_PREFIX = "tool-";
const SHOT_KEEP = 40;
function pruneByPrefix(dir, prefix, keep) {
  try {
    const shots = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".png")).map((f) => ({ f, ms: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.ms - a.ms);
    let removed = 0;
    for (const { f } of shots.slice(keep)) {
      try {
        unlinkSync(join(dir, f));
        removed += 1;
      } catch {
      }
    }
    return removed;
  } catch {
    return 0;
  }
}
function pruneAutoShots(dir, keep = SHOT_KEEP) {
  return pruneByPrefix(dir, AUTO_SHOT_PREFIX, keep);
}
function pruneToolShots(dir, keep = SHOT_KEEP) {
  return pruneByPrefix(dir, TOOL_SHOT_PREFIX, keep);
}
async function autoShot(api, device, root, label) {
  try {
    const value = await api.screenshot({ device, root, auto: true, label });
    return typeof value?.path === "string" ? value.path : "";
  } catch {
    return "";
  }
}
async function shotFields(api, device, root, label, ctx, read) {
  const path = await autoShot(api, device, root, label);
  if (!path) return {};
  const image = read ? await attachmentRefForImage(ctx, path) : void 0;
  return image ? { shot: path, image } : { shot: path };
}
function sliceText(text, offset = 0, limit = 8e3) {
  const full = String(text ?? "");
  const start = Math.max(0, Math.floor(offset) || 0);
  const size = Math.max(1, Math.floor(limit) || 0);
  const body = full.slice(start, start + size);
  const nextOffset = start + size < full.length ? start + size : null;
  return { text: body, total: full.length, offset: start, nextOffset };
}
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function decodePng(file) {
  const data = Buffer.isBuffer(file) ? file : Buffer.from(file);
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("\u4E0D\u662F PNG(\u7B7E\u540D\u4E0D\u7B26)");
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = { width: chunk.readUInt32BE(0), height: chunk.readUInt32BE(4), depth: chunk[8], color: chunk[9], interlace: chunk[12] };
    } else if (type === "IDAT") idat.push(chunk);
    else if (type === "IEND") break;
  }
  if (!header) throw new Error("PNG \u7F3A\u5C11 IHDR");
  if (header.depth !== 8) throw new Error(`PNG \u4F4D\u6DF1 ${header.depth} \u4E0D\u652F\u6301(\u53EA\u5904\u7406 8 \u4F4D)`);
  if (header.interlace !== 0) throw new Error("PNG \u662F\u9694\u884C(interlace)\u7F16\u7801,\u4E0D\u652F\u6301");
  const channels = header.color === 6 ? 4 : header.color === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`PNG \u989C\u8272\u7C7B\u578B ${header.color} \u4E0D\u652F\u6301(\u53EA\u5904\u7406 RGB/RGBA)`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  if (raw.length < header.height * (stride + 1)) throw new Error("PNG \u6570\u636E\u4E0D\u5B8C\u6574");
  const pixels = Buffer.alloc(header.height * stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1);
    const start = y * stride;
    const above = start - stride;
    for (let i = 0; i < stride; i += 1) {
      const byte = line[i];
      const left = i >= channels ? pixels[start + i - channels] : 0;
      const up = y > 0 ? pixels[above + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[above + i - channels] : 0;
      const value = filter === 0 ? byte : filter === 1 ? byte + left : filter === 2 ? byte + up : filter === 3 ? byte + (left + up >> 1) : filter === 4 ? byte + paeth(left, up, upLeft) : NaN;
      if (Number.isNaN(value)) throw new Error(`PNG \u884C\u8FC7\u6EE4\u7C7B\u578B ${filter} \u4E0D\u652F\u6301`);
      pixels[start + i] = value & 255;
    }
  }
  return { width: header.width, height: header.height, channels, pixels };
}
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 4294967295;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function pngChunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}
function encodePng(image) {
  const { width, height, channels, pixels } = image;
  if (channels !== 3 && channels !== 4) throw new Error(`\u65E0\u6CD5\u7F16\u7801 ${channels} \u901A\u9053(\u53EA\u5904\u7406 RGB/RGBA)`);
  if (width <= 0 || height <= 0) throw new Error(`\u65E0\u6CD5\u7F16\u7801 ${width}x${height} \u7684\u56FE`);
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}
function cropPng(image, rect) {
  const asked = { x: Math.floor(rect.x), y: Math.floor(rect.y), w: Math.floor(rect.w), h: Math.floor(rect.h) };
  const x = Math.max(0, Math.min(image.width - 1, asked.x));
  const y = Math.max(0, Math.min(image.height - 1, asked.y));
  const w = Math.max(1, Math.min(image.width - x, asked.w));
  const h = Math.max(1, Math.min(image.height - y, asked.h));
  const clamped = x !== asked.x || y !== asked.y || w !== asked.w || h !== asked.h;
  const stride = image.width * image.channels;
  const rowBytes = w * image.channels;
  const out = Buffer.alloc(h * rowBytes);
  for (let row = 0; row < h; row += 1) {
    const from = (y + row) * stride + x * image.channels;
    image.pixels.copy(out, row * rowBytes, from, from + rowBytes);
  }
  return { image: { width: w, height: h, channels: image.channels, pixels: out }, rect: { x, y, w, h }, clamped };
}
function diffPng(before, after, tolerance = 0) {
  const total = before.width * before.height;
  if (before.width !== after.width || before.height !== after.height || before.channels !== after.channels) {
    return { same: false, diffRatio: 1, changedPixels: total, totalPixels: total };
  }
  let changed = 0;
  for (let i = 0; i < before.pixels.length; i += before.channels) {
    for (let c = 0; c < before.channels; c += 1) {
      if (Math.abs(before.pixels[i + c] - after.pixels[i + c]) > tolerance) {
        changed += 1;
        break;
      }
    }
  }
  return { same: changed === 0, diffRatio: Number((changed / total).toFixed(6)), changedPixels: changed, totalPixels: total };
}
function createToolDefs(api, ctx = null) {
  const lastLayout = /* @__PURE__ */ new Map();
  const lastRender = /* @__PURE__ */ new Map();
  const lastDump = /* @__PURE__ */ new Map();
  const lastShot = /* @__PURE__ */ new Map();
  const emu = {
    name: "emu",
    description: "List/start/stop emulators via devecocli (start waits until online).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "start", "stop"], description: "list | start (waits online) | stop" },
        name: { type: "string", description: "instance name (start/stop)" }
      },
      required: ["action"]
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args) {
      const cli = resolveDevecoCli();
      if (!cli) return { ok: false, error: "devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI" };
      const action = String(args?.action || "");
      if (action === "list") {
        const r = await runCli([process.execPath, cli, "emulator", "list", "--format", "json"], { timeoutMs: 3e4 });
        const instances = parseJsonArray(r.output).map((it) => ({ name: it.name, status: it.status, serial: it.serial ?? null, osVersion: it.osVersion }));
        return { ok: r.code === 0, instances, error: r.code === 0 ? "" : tailText(r.output, 5) };
      }
      const name2 = typeof args?.name === "string" && args.name.trim() ? args.name.trim() : "";
      if (!name2) return { ok: false, error: "name is required for start/stop" };
      if (action === "start") {
        try {
          await ensureImageReady(cli, name2);
        } catch (error) {
          return { ok: false, stage: "image", error: error instanceof Error ? error.message : String(error) };
        }
        const r = await runCli([process.execPath, cli, "emulator", "start", name2], { timeoutMs: 24e4 });
        if (r.code !== 0) return { ok: false, stage: "start", code: r.code, error: tailText(r.output, 8) };
        const { ready, serial } = await waitDeviceReady(cli, name2);
        return { ok: true, ready, serial };
      }
      if (action === "stop") {
        const r = await runCli([process.execPath, cli, "emulator", "stop", name2], { timeoutMs: 6e4 });
        return { ok: r.code === 0, code: r.code, error: r.code === 0 ? "" : tailText(r.output, 5) };
      }
      return { ok: false, error: `unknown action ${action}` };
    }
  };
  const DRAG_SPEED = 400;
  const emuUi = {
    name: "emu_ui",
    description: 'Drive the emulator screen via devecocli ui. layout: tree lines (#id Type [x1,y1,x2,y2] "text" flags) + page title (window/allWindows reach system and UIExtension windows); click/longPress/doubleTap by label, id or x/y (results carry an ancestors breadcrumb, and matchCount/candidates when a label is ambiguous); waitFor/waitForChange/waitForIdle instead of sleeping; steps batches actions; drag/fling/dircfling/swipe/text/screenshot. Screenshots are static frames only; pinch/zoom (multi-finger) is unsupported.',
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["layout", "observe", "click", "text", "swipe", "screenshot", "waitFor", "waitForChange", "waitForIdle", "longPress", "doubleTap", "drag", "fling", "dircfling", "steps"], description: "UI action" },
        steps: { type: "array", items: { type: "object" }, description: "steps: [{action,...}] in order (see onFail)" },
        onFail: { type: "string", enum: ["stop", "continue"], description: "steps: stop (default, returns stoppedAt) | continue (runs all, returns failedAt)" },
        changedOnly: { type: "boolean", description: "layout/thenLayout: only changed lines vs the previous render" },
        device: { type: "string", description: "serial (default: first running)" },
        id: { type: "integer", description: "press: node id from the last layout" },
        label: { type: "string", description: "press: node text; exact first, else smallest clickable ancestor" },
        labelIndex: { type: "integer", description: "press: candidate index when label repeats (see matchCount)" },
        depth: { type: "integer", description: "layout/waitFor: depth (0=unlimited, 1=root)" },
        filter: { type: "object", description: "layout/thenLayout: node filter", properties: { type: { type: "string" }, textRegex: { type: "string" }, clickableOnly: { type: "boolean" } } },
        full: { type: "boolean", description: "layout: include unlabeled/inert nodes (--mode full)" },
        asJson: { type: "boolean", description: "layout: flat JSON nodes (label: inherited text)" },
        window: { type: "integer", description: "layout: window id from `devecocli ui window list`" },
        allWindows: { type: "boolean", description: "layout: every window incl. system/UIExtension ones (--all-windows; for pickers, permission dialogs)" },
        textRegex: { type: "string", description: "waitFor: JS regex on node text" },
        clickableOnly: { type: "boolean", description: "waitFor: clickable only" },
        absent: { type: "boolean", description: "waitFor: succeed when the match is gone instead of present" },
        timeoutMs: { type: "integer", description: "wait: total ms (5000); one dump (1.5-3s) cannot be interrupted, so elapsed may exceed it by one dump" },
        pollMs: { type: "integer", description: "wait: poll ms (200)" },
        stablePolls: { type: "integer", description: "waitForIdle: stable dumps (2)" },
        thenLayout: { type: "boolean", description: "click: layout after the tap (honours filter/changedOnly)" },
        thenWaitFor: {
          type: "object",
          properties: {
            text: { type: "string" },
            textRegex: { type: "string" },
            absent: { type: "boolean" },
            timeoutMs: { type: "integer" },
            pollMs: { type: "integer" }
          },
          additionalProperties: true,
          description: "click: wait for this condition after the tap, then dump (same shape as waitFor; replaces the fixed waitMs guess)"
        },
        waitMs: { type: "integer", description: "thenLayout ms (600, max 5000); thenWaitFor timeout floor" },
        x: { type: "integer", description: "press/swipe/drag: start x" },
        y: { type: "integer", description: "press/swipe/drag: start y" },
        x2: { type: "integer", description: "swipe/drag: end x" },
        y2: { type: "integer", description: "swipe/drag: end y" },
        velocity: { type: "integer", description: "drag/swipe/fling: px/s; drag defaults to 400 (a speedless drag can be a silent no-op)" },
        direction: { type: "string", description: "dircfling: left|right|up|down" },
        text: { type: "string", description: "text: string to type, or the waitFor match" },
        root: { type: "string", description: "screenshot: dir for the PNG (default: workspace)" },
        baseline: { type: "string", description: 'screenshot: PNG path or "last" to compare' },
        read: { type: "boolean", description: "attach the image; a failed click/wait also attaches its shot" },
        keep: { type: "boolean", description: "screenshot: keep the PNG on disk (default true); false deletes it once the image is attached; ignored with baseline" },
        clip: {
          type: "object",
          properties: { x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" } },
          required: ["x", "y", "w", "h"],
          additionalProperties: false,
          description: "screenshot/observe: crop to this device-pixel rect (layout coordinates) so the preview stays 1:1; not with baseline"
        },
        log: {
          type: "object",
          properties: {
            level: { type: "string" },
            keyword: { type: "string" },
            tail: { type: "integer" },
            crash: { type: "boolean" }
          },
          additionalProperties: true,
          description: "observe: also return device logs in the same call (hmos_log parameters)"
        }
      },
      required: ["action"]
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args, exec) {
      const cli = resolveDevecoCli();
      if (!cli) return { ok: false, error: "devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI" };
      const device = (typeof args?.device === "string" && args.device.trim() ? args.device.trim() : "") || await firstRunningSerial(cli);
      if (!device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' };
      const run = (argv, timeoutMs) => runCli([process.execPath, cli, ...argv], { timeoutMs });
      const depth = Number.isFinite(args?.depth) ? Math.max(0, Math.floor(args.depth)) : 0;
      const depthOf = (step) => Number.isFinite(step?.depth) ? Math.max(0, Math.floor(step.depth)) : depth;
      const shotRoot = sessionWorkspace(exec);
      const px = (n) => String(Math.round(Number(n)));
      const windowScope = (step) => ({
        win: Number.isFinite(step?.window) ? Number(step?.window) : Number.isFinite(args?.window) ? Number(args.window) : void 0,
        every: typeof step?.allWindows === "boolean" ? step.allWindows : args?.allWindows === true
      });
      const dumpLayout = async (full = false, atDepth = depth, step) => {
        const { win, every } = windowScope(step);
        const at = every ? 0 : atDepth;
        const argv = ["ui", "layout", "--device", device, "--depth", String(at)];
        if (full) argv.push("--mode", "full");
        if (every) argv.push("--all-windows");
        else if (win !== void 0) argv.push("--window", String(Math.floor(win)));
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const r = await run(argv, 3e4);
          if (r.code !== 0) return { ok: false, lines: [], error: tailText(r.output, 6) };
          const lines = cleanLayout(r.output).split(/\r?\n/).map(parseLayoutLine).filter((l) => l.bounds);
          if (lines.length > 0) {
            lastLayout.set(device, lines);
            lastDump.set(device, lines.map((l) => l.raw.trim()));
            return { ok: true, lines };
          }
          if (attempt < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 400));
        }
        return { ok: true, lines: [] };
      };
      const renderFor = (rows, changedOnly) => {
        const keys = rawKeys(rows);
        if (keys.length === 0) return "matched:0";
        const previous = lastRender.get(device);
        lastRender.set(device, keys);
        return changedOnly && previous ? diffLines(previous, keys) : capLines(renderLines(rows)).join("\n");
      };
      const perform = async (a) => {
        const action = String(a?.action || "");
        if (action === "steps") {
          const list = Array.isArray(a?.steps) ? a.steps : [];
          if (list.length === 0) return { ok: false, error: "steps \u9700\u8981\u4E00\u4E2A\u975E\u7A7A\u7684 steps \u6570\u7EC4(\u5143\u7D20\u4E0E\u666E\u901A\u8C03\u7528\u540C\u53C2)\u3002" };
          const keepGoing = a?.onFail === "continue";
          const done = [];
          let last = null;
          let stoppedAt = -1;
          const failedAt = [];
          for (let i = 0; i < list.length; i += 1) {
            const step = list[i] && typeof list[i] === "object" ? list[i] : {};
            const stepAction = String(step.action || "");
            const at = Date.now();
            if (!stepAction || stepAction === "steps") {
              last = { ok: false, error: stepAction === "steps" ? "steps \u4E0D\u80FD\u5D4C\u5957(\u6BCF\u4E00\u6B65\u90FD\u5FC5\u987B\u662F\u4E00\u4E2A\u5177\u4F53\u52A8\u4F5C)" : "\u6BCF\u4E00\u6B65\u90FD\u9700\u8981 action" };
            } else {
              try {
                last = await perform(step);
              } catch (error) {
                last = { ok: false, error: error instanceof Error ? error.message : String(error) };
              }
            }
            done.push({ action: stepAction || "?", ok: last?.ok === true, ms: Date.now() - at, summary: stepSummary(stepAction, last) });
            if (last?.ok !== true) {
              failedAt.push(i);
              if (!keepGoing) {
                stoppedAt = i;
                break;
              }
            }
          }
          const failed = failedAt.length > 0;
          return {
            ok: !failed,
            device,
            steps: done,
            last,
            // `stoppedAt` means the batch really stopped there — only `stop` can do that. A `continue`
            // batch ran every step, so it reports the failing indices instead of a stop position that
            // never happened.
            ...stoppedAt >= 0 ? { stoppedAt } : {},
            ...keepGoing && failed ? { failedAt } : {}
          };
        }
        if (action === "layout") {
          const at = depthOf(a);
          const dump = await dumpLayout(a?.full === true, at, a);
          if (!dump.ok) return { ok: false, device, error: dump.error };
          const rows = selectLayoutLines(dump.lines, a?.filter);
          const page = pageTitle(dump.lines);
          const textless = at > 0 && !dump.lines.some((line) => line.text);
          const overrode = windowScope(a).every && at > 0;
          const note = overrode ? `allWindows \u5DF2\u6309 depth:0 \u6267\u884C:depth=${at} \u65F6 devecocli \u53EA\u56DE\u7A97\u53E3\u6839\u3001\u5B50\u6811\u5168\u7A7A(\u5BB9\u6613\u88AB\u8BFB\u6210"\u8FD9\u5C4F\u4EC0\u4E48\u90FD\u6CA1\u6709");\u770B\u5230\u7684\u8FD9\u68F5\u6811\u662F\u5168\u90E8\u7A97\u53E3\u7684\u5B8C\u6574\u5185\u5BB9\u3002` : textless ? `\u8FD9\u6B21 dump \u53EA\u6709\u5BB9\u5668\u3001\u6CA1\u6709\u4EFB\u4F55\u6587\u5B57:depth=${at} \u53EA\u5230\u7B2C ${at} \u5C42${a?.full === true ? "(full \u6A21\u5F0F\u8FD8\u4F1A\u591A\u51FA window/root \u4E24\u5C42)" : ""};\u8981\u770B\u5185\u5BB9\u8BF7\u7528 depth:0 \u6216\u4E0D\u4F20 depth\u3002` : void 0;
          return a?.asJson ? { ok: true, device, total: dump.lines.length, page: page || null, ...note ? { note } : {}, nodes: layoutJson(rows, dump.lines) } : { ok: true, device, total: dump.lines.length, page: page || null, ...note ? { note } : {}, tree: renderFor(rows, a?.changedOnly === true) };
        }
        if (action === "click" || action === "longPress" || action === "doubleTap") {
          const verb = action === "click" ? "click" : action === "longPress" ? "longclick" : "doubleclick";
          let point = null;
          let usedId = null;
          let ancestors = [];
          let page = "";
          let matchCount = 0;
          let pickedIndex = 0;
          let candidates = null;
          let inexact = false;
          if (Number.isFinite(a?.x) && Number.isFinite(a?.y)) {
            point = { x: a.x, y: a.y };
          } else if (Number.isFinite(a?.id)) {
            const stored = lastLayout.get(device);
            if (!stored) return { ok: false, device, error: "\u5C1A\u65E0 layout \u8BB0\u5F55:id \u6765\u81EA\u6700\u8FD1\u4E00\u6B21 layout,\u8BF7\u5148\u8C03\u7528 layout" };
            const found = pointOf(stored, Number(a.id));
            if (!found) return { ok: false, device, error: `id ${a.id} \u5728\u6700\u8FD1\u4E00\u6B21 layout \u4E2D\u4E0D\u5B58\u5728\u6216\u6CA1\u6709\u5750\u6807` };
            point = found;
            usedId = Number(a.id);
            ancestors = ancestorLabels(stored, usedId);
            page = pageTitle(stored);
          } else if (typeof a?.label === "string" && a.label.trim()) {
            const dump = await dumpLayout();
            if (!dump.ok) return { ok: false, device, error: dump.error };
            const matches = labelMatches(dump.lines, a.label);
            if (!matches.length) {
              const shot = await shotFields(api, device, shotRoot, "click", ctx, a?.read === true);
              return { ok: false, device, error: `no layout node matching "${a.label}"`, page: pageTitle(dump.lines) || null, ...shot };
            }
            const want = Number.isFinite(a?.labelIndex) ? Math.max(0, Math.floor(a.labelIndex)) : 0;
            matchCount = matches.length;
            pickedIndex = want;
            if (matchCount > 1) candidates = candidateList(dump.lines, matches);
            if (want >= matchCount) {
              return { ok: false, device, error: `"${a.label}" \u5339\u914D ${matchCount} \u4E2A\u5019\u9009,labelIndex ${want} \u8D8A\u754C(0..${matchCount - 1})`, matchCount, candidates };
            }
            const match = matches[want];
            point = pointOf(dump.lines, match.targetIndex);
            if (!point) return { ok: false, device, error: `\u5339\u914D\u5230\u7684\u8282\u70B9\u6CA1\u6709\u53EF\u7528\u5750\u6807:${match.target.raw.trim()}` };
            ancestors = ancestorLabels(dump.lines, match.targetIndex);
            page = pageTitle(dump.lines);
            inexact = !match.exact;
          } else return { ok: false, error: `${action} needs id, label or x/y` };
          const r = await run(["ui", verb, px(point.x), px(point.y), "--device", device], 2e4);
          if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 4) };
          const result = { ok: true, device, x: Math.round(point.x), y: Math.round(point.y) };
          if (usedId !== null) result.id = usedId;
          result.page = page || null;
          if (ancestors.length) result.ancestors = ancestors;
          if (matchCount > 1) {
            result.matchCount = matchCount;
            result.pickedIndex = pickedIndex;
            result.candidates = candidates;
          }
          if (inexact) result.matchedBy = "contains";
          if (action === "click" && (a?.thenLayout || a?.thenWaitFor)) {
            const condition = a?.thenWaitFor && typeof a.thenWaitFor === "object" ? a.thenWaitFor : null;
            if (condition) {
              const waited = await perform({
                ...condition,
                action: "waitFor",
                timeoutMs: Number.isFinite(condition.timeoutMs) ? condition.timeoutMs : Number.isFinite(a?.waitMs) ? a.waitMs : 5e3,
                ...Number.isFinite(condition.pollMs) ? { pollMs: condition.pollMs } : {}
              });
              result.thenWaitFor = {
                ok: waited?.ok === true,
                elapsedMs: waited?.elapsedMs,
                ...condition.absent === true ? { absent: true } : { matched: Array.isArray(waited?.matched) ? waited.matched.length : 0 },
                ...waited?.ok === true ? {} : { error: waited?.error ?? "\u7B49\u5F85\u6761\u4EF6\u672A\u5728\u8D85\u65F6\u5185\u6210\u7ACB" }
              };
            } else {
              const wait = Number.isFinite(a?.waitMs) ? Math.max(0, Math.min(5e3, a.waitMs)) : 600;
              if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
            }
            const after = await dumpLayout(false, depthOf(a));
            result.tree = after.ok ? renderFor(selectLayoutLines(after.lines, a?.filter), a?.changedOnly === true) : after.error;
          }
          return result;
        }
        if (action === "text") {
          const value = typeof a?.text === "string" ? a.text : "";
          if (!value) return { ok: false, error: "text is required" };
          const r = await run(["ui", "text", "--device", device, "--", value], 2e4);
          return { ok: r.code === 0, device, error: r.code === 0 ? "" : tailText(r.output, 4) };
        }
        if (action === "swipe") {
          if (![a?.x, a?.y, a?.x2, a?.y2].every((n) => Number.isFinite(n))) return { ok: false, error: "swipe needs x, y, x2, y2" };
          const argv = ["ui", "swipe", px(a.x), px(a.y), px(a.x2), px(a.y2), "--device", device];
          if (Number.isFinite(a?.velocity)) argv.push("--speed", String(Math.max(1, Math.floor(a.velocity))));
          const r = await run(argv, 2e4);
          return { ok: r.code === 0, device, error: r.code === 0 ? "" : tailText(r.output, 4) };
        }
        if (action === "screenshot") {
          const asked = typeof a?.root === "string" && a.root.trim() ? a.root.trim() : shotRoot;
          const wanted = typeof a?.baseline === "string" ? a.baseline.trim() : "";
          const read = a?.read === true;
          const clipWanted = a?.clip && typeof a.clip === "object" ? a.clip : null;
          if (clipWanted && wanted) {
            return { ok: false, device, error: 'clip \u4E0E baseline \u4E92\u65A5:\u57FA\u7EBF\u6BD4\u5BF9\u7684\u662F\u4E00\u6574\u5C4F,\u88C1\u526A\u4F1A\u8BA9"\u53D8\u6CA1\u53D8"\u7684\u5750\u6807\u8BED\u4E49\u53D8\u6A21\u7CCA\u3002' };
          }
          if (clipWanted && ![clipWanted.x, clipWanted.y, clipWanted.w, clipWanted.h].every((n) => Number.isFinite(n))) {
            return { ok: false, device, error: "clip \u9700\u8981 {x, y, w, h}(\u8BBE\u5907\u50CF\u7D20,\u4E0E layout \u7684 [x1,y1,x2,y2] \u540C\u4E00\u5750\u6807\u7CFB)\u3002" };
          }
          const discard = a?.keep === false && !wanted && read;
          const value = await api.screenshot({ device, root: asked, origin: "tool" });
          const rel = relativeTo(asked, value.path);
          let clipped = null;
          if (clipWanted) {
            try {
              const region = cropPng(decodePng(readFileSync(value.path)), { x: clipWanted.x, y: clipWanted.y, w: clipWanted.w, h: clipWanted.h });
              writeFileSync(value.path, encodePng(region.image));
              clipped = {
                ...region.rect,
                ...region.clamped ? { clamped: true, requested: { x: clipWanted.x, y: clipWanted.y, w: clipWanted.w, h: clipWanted.h } } : {}
              };
            } catch (error) {
              return { ok: false, device, path: value.path, error: `\u88C1\u526A\u5931\u8D25:${error instanceof Error ? error.message : String(error)}` };
            }
          }
          if (!wanted) {
            if (!discard) {
              lastShot.set(device, {
                path: value.path,
                ...clipped ? { clip: { x: clipped.x, y: clipped.y, w: clipped.w, h: clipped.h } } : {}
              });
            }
            const image = read ? await attachmentRefForImage(ctx, value.path) : void 0;
            let gone = false;
            if (discard && image) {
              try {
                unlinkSync(value.path);
                gone = true;
              } catch {
              }
            }
            return {
              ok: true,
              ...gone ? {} : { path: value.path },
              ...gone || rel === value.path ? {} : { rel },
              device: value.device,
              ...clipped ? { clip: clipped } : {},
              ...gone ? { discarded: true } : {},
              ...image ? { image } : {},
              ...read && !image ? { imageUnavailable: "\u9644\u4EF6\u670D\u52A1\u4E0D\u53EF\u7528\u6216\u8BE5\u56FE\u8D85\u51FA\u90E8\u7F72\u9650\u5236,\u53EA\u56DE\u4E86\u8DEF\u5F84" } : {},
              ...a?.keep === false && read && !gone ? { keepFailed: "\u56FE\u5DF2\u7559\u5728\u76D8\u4E0A(\u9644\u4EF6\u6CA1\u80FD\u751F\u6210,\u5220\u4E86\u5C31\u6CA1\u56FE\u53EF\u770B)\u3002" } : {}
            };
          }
          const previous = wanted === "last" ? lastShot.get(device) : void 0;
          const baselinePath = wanted === "last" ? previous?.path ?? "" : wanted;
          const capture = { diffPath: value.path, ...rel !== value.path ? { rel } : {} };
          if (!baselinePath) return { ok: false, device, error: "\u8FD8\u6CA1\u6709\u57FA\u7EBF:\u5148\u4E0D\u5E26 baseline \u8C03\u4E00\u6B21 screenshot,\u6216\u76F4\u63A5\u4F20 PNG \u8DEF\u5F84\u3002", ...capture };
          if (previous?.clip) {
            const { x, y, w, h } = previous.clip;
            return {
              ok: false,
              device,
              error: `\u4E0A\u4E00\u6B21\u622A\u56FE\u662F\u88C1\u526A\u56FE(${x},${y},${w},${h}),\u4E0D\u80FD\u5F53\u6574\u5C4F\u57FA\u7EBF;\u8BF7\u5148\u7528\u4E0D\u5E26 clip \u7684 screenshot \u5EFA\u7ACB\u6574\u5C4F\u57FA\u7EBF,\u6216\u76F4\u63A5\u4F20\u6574\u5C4F PNG \u8DEF\u5F84\u3002`,
              ...capture
            };
          }
          if (!existsSync(baselinePath)) return { ok: false, device, error: `\u57FA\u7EBF\u6587\u4EF6\u4E0D\u5B58\u5728:${baselinePath}`, ...capture };
          const before = readFileSync(baselinePath);
          const after = readFileSync(value.path);
          if (before.equals(after)) {
            try {
              unlinkSync(value.path);
            } catch {
            }
            return { ok: true, device, same: true, diffRatio: 0 };
          }
          let verdict;
          try {
            verdict = diffPng(decodePng(before), decodePng(after));
          } catch (error) {
            return { ok: false, device, error: `\u65E0\u6CD5\u6BD4\u5BF9\u57FA\u7EBF:${error instanceof Error ? error.message : String(error)}`, diffPath: value.path };
          }
          if (verdict.same) {
            try {
              unlinkSync(value.path);
            } catch {
            }
            return { ok: true, device, same: true, diffRatio: 0 };
          }
          const movedImage = read ? await attachmentRefForImage(ctx, value.path) : void 0;
          return {
            ok: true,
            device,
            same: false,
            diffRatio: verdict.diffRatio,
            changedPixels: verdict.changedPixels,
            // `diffRatio` without its denominator is hard to sanity-check; hand the total over too.
            totalPixels: verdict.totalPixels,
            diffPath: value.path,
            ...rel !== value.path ? { rel } : {},
            ...movedImage ? { image: movedImage } : {},
            ...read && !movedImage ? { imageUnavailable: "\u9644\u4EF6\u670D\u52A1\u4E0D\u53EF\u7528\u6216\u8BE5\u56FE\u8D85\u51FA\u90E8\u7F72\u9650\u5236,\u53EA\u56DE\u4E86\u8DEF\u5F84" } : {}
          };
        }
        if (action === "drag" || action === "fling") {
          if (![a?.x, a?.y, a?.x2, a?.y2].every((n) => Number.isFinite(n))) return { ok: false, error: `${action} needs x, y, x2, y2` };
          const argv = ["ui", action, px(a.x), px(a.y), px(a.x2), px(a.y2), "--device", device];
          const speed = Number.isFinite(a?.velocity) ? Math.max(1, Math.floor(a.velocity)) : action === "drag" ? DRAG_SPEED : null;
          if (speed !== null) argv.push("--speed", String(speed));
          const r = await run(argv, 2e4);
          return { ok: r.code === 0, device, error: r.code === 0 ? "" : tailText(r.output, 4) };
        }
        if (action === "dircfling") {
          const dir = typeof a?.direction === "string" ? a.direction.trim() : "";
          if (!dir) return { ok: false, error: "dircfling needs direction" };
          const r = await run(["ui", "dircfling", dir, "--device", device], 2e4);
          return { ok: r.code === 0, device, error: r.code === 0 ? "" : tailText(r.output, 4) };
        }
        if (action === "waitFor") {
          const timeout = Number.isFinite(a?.timeoutMs) ? Math.max(0, Math.min(6e4, a.timeoutMs)) : 5e3;
          const poll = Number.isFinite(a?.pollMs) ? Math.max(50, Math.min(2e3, a.pollMs)) : 200;
          const absent = a?.absent === true;
          const started = Date.now();
          let last = [];
          for (; ; ) {
            const dump = await dumpLayout();
            if (!dump.ok) return { ok: false, device, error: dump.error };
            last = dump.lines;
            const hits = matchLayout(last, {
              text: typeof a?.text === "string" ? a.text : "",
              textRegex: a?.textRegex,
              clickableOnly: a?.clickableOnly
            });
            if (absent ? hits.length === 0 : hits.length > 0) {
              const found = pageTitle(last);
              return {
                ok: true,
                device,
                elapsedMs: Date.now() - started,
                ...absent ? { absent: true, matched: [] } : { matched: hits },
                page: found || null,
                tree: renderLayout(last.map((line, index) => ({ index, line })))
              };
            }
            if (Date.now() - started + poll > timeout) break;
            await new Promise((resolveWait) => setTimeout(resolveWait, poll));
          }
          const page = pageTitle(last);
          const shot = await shotFields(api, device, shotRoot, action, ctx, a?.read === true);
          const late = absent ? matchLayout(last, { text: typeof a?.text === "string" ? a.text : "", textRegex: a?.textRegex, clickableOnly: a?.clickableOnly }) : [];
          return { ok: false, device, matched: late, elapsedMs: Date.now() - started, ...absent ? { absent: true } : {}, page: page || null, ...shot, tree: renderLayout(last.map((line, index) => ({ index, line }))) };
        }
        if (action === "waitForChange") {
          const timeout = Number.isFinite(a?.timeoutMs) ? Math.max(0, Math.min(6e4, a.timeoutMs)) : 5e3;
          const poll = Number.isFinite(a?.pollMs) ? Math.max(50, Math.min(2e3, a.pollMs)) : 300;
          const started = Date.now();
          let baseline = lastDump.get(device);
          if (!baseline) {
            const first = await dumpLayout();
            if (!first.ok) return { ok: false, device, error: first.error };
            baseline = first.lines.map((l) => l.raw.trim());
          }
          let polls = 0;
          let last = lastLayout.get(device) ?? [];
          for (; ; ) {
            const dump = await dumpLayout();
            if (!dump.ok) return { ok: false, device, error: dump.error };
            polls += 1;
            last = dump.lines;
            const moved = diffLines(baseline, dump.lines.map((l) => l.raw.trim()));
            if (moved !== "changed:0") {
              return { ok: true, device, polls, elapsedMs: Date.now() - started, changed: capLines(moved.split("\n")).join("\n") };
            }
            if (Date.now() - started + poll > timeout) break;
            await new Promise((resolveWait) => setTimeout(resolveWait, poll));
          }
          const page = pageTitle(last);
          const shot = await shotFields(api, device, shotRoot, action, ctx, a?.read === true);
          return { ok: false, device, polls, elapsedMs: Date.now() - started, page: page || null, ...shot, tree: renderLayout(last.map((line, index) => ({ index, line }))) };
        }
        if (action === "waitForIdle") {
          const timeout = Number.isFinite(a?.timeoutMs) ? Math.max(0, Math.min(6e4, a.timeoutMs)) : 5e3;
          const poll = Number.isFinite(a?.pollMs) ? Math.max(50, Math.min(2e3, a.pollMs)) : 300;
          const need = Number.isFinite(a?.stablePolls) ? Math.max(2, Math.min(10, Math.floor(a.stablePolls))) : 2;
          const started = Date.now();
          let previous = "";
          let stable = 0;
          let polls = 0;
          let last = [];
          for (; ; ) {
            const dump = await dumpLayout();
            if (!dump.ok) return { ok: false, device, error: dump.error };
            last = dump.lines;
            polls += 1;
            const now = dump.lines.map((l) => l.raw).join("\n");
            stable = now !== "" && now === previous ? stable + 1 : 1;
            previous = now;
            if (stable >= need) {
              const settled = pageTitle(last);
              return {
                ok: true,
                device,
                polls,
                elapsedMs: Date.now() - started,
                page: settled || null,
                tree: renderLayout(last.map((line, index) => ({ index, line })))
              };
            }
            if (Date.now() - started + poll > timeout) break;
            await new Promise((resolveWait) => setTimeout(resolveWait, poll));
          }
          const idlePage = pageTitle(last);
          const idleShot = await shotFields(api, device, shotRoot, action, ctx, a?.read === true);
          return { ok: false, device, polls, elapsedMs: Date.now() - started, page: idlePage || null, ...idleShot, tree: renderLayout(last.map((line, index) => ({ index, line }))) };
        }
        if (action === "observe") {
          const seen = await perform({ ...a, action: "layout" });
          if (seen?.ok !== true) return seen;
          const extra = {};
          if (a?.log && typeof a.log === "object") {
            const logs = await hmosLog.execute({ ...a.log, ...device ? { device } : {} }, exec);
            extra.log = logs?.ok === true ? { count: logs.count, lines: logs.lines } : { error: logs?.error ?? "\u65E5\u5FD7\u8BFB\u53D6\u5931\u8D25" };
          }
          if (a?.read !== true) return { ...seen, ...extra };
          const shot = await perform({ ...a, action: "screenshot" });
          if (shot?.ok === true) return { ...seen, ...extra, ...shot, ok: true };
          return { ...seen, ...extra, shotError: shot?.error ?? "\u622A\u56FE\u5931\u8D25" };
        }
        return { ok: false, error: `unknown action ${action}` };
      };
      return perform(args);
    }
  };
  const hmosDeploy = {
    name: "hmos_deploy",
    description: "Build and deploy a project via devecocli (run: build -> install -> launch; buildOnly: build only). Returns phase, duration, ArkTS errors with file/line, hap path and an output tail.",
    parameters: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "project root (contains build-profile.json5)" },
        device: { type: "string", description: "serial (default: first running emulator)" },
        module: { type: "string", description: "module (default: entry)" },
        buildOnly: { type: "boolean", description: "build only: no device, no install/launch" },
        skipBuild: { type: "boolean", description: "run --skip-build: install + launch existing artifacts" },
        read: { type: "boolean", description: "attach the failure screenshot when the deploy fails, not just its path" }
      },
      required: ["projectPath"]
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args, exec) {
      const cli = resolveDevecoCli();
      if (!cli) return { ok: false, error: "devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI" };
      const projectPath = projectRootOf(args?.projectPath, exec);
      if (!projectPath) return { ok: false, error: "projectPath is required" };
      if (!existsSync(join(projectPath, PROJECT_MARK))) {
        return { ok: false, error: `\u672A\u627E\u5230 ${PROJECT_MARK}:\u5DF2\u6309 ${projectPath} \u67E5\u627E(\u4F20\u76EE\u5F55\u65F6\u8BF7\u7ED9\u5DE5\u7A0B\u6839,\u76F8\u5BF9\u8DEF\u5F84\u6309\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u89E3\u6790)\u3002` };
      }
      const buildOnly = args?.buildOnly === true;
      const skipBuild = args?.skipBuild === true;
      const device = buildOnly ? "" : (typeof args?.device === "string" && args.device.trim() ? args.device.trim() : "") || await firstRunningSerial(cli);
      if (!buildOnly && !device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' };
      const modules = readModules(projectPath);
      const asked = typeof args?.module === "string" ? args.module.trim() : "";
      const modulesUnreadable = modules.length === 0;
      if (asked && !modulesUnreadable && !modules.includes(asked)) {
        return { ok: false, error: `\u6A21\u5757\u201C${asked}\u201D\u4E0D\u5C5E\u4E8E\u8BE5\u5DE5\u7A0B(\u53EF\u9009:${modules.join("\u3001")})` };
      }
      const chosen = asked || (modules.includes("entry") ? "entry" : modules[0]);
      const unreadNote = modulesUnreadable ? `\u672A\u80FD\u4ECE build-profile.json5 \u8BFB\u51FA\u6A21\u5757\u540D(stripJson5 \u53EA\u8986\u76D6\u5E38\u89C1 JSON5 \u5199\u6CD5),\u672C\u6B21${asked ? `\u6309\u4F60\u6307\u5B9A\u7684 module=\u201C${asked}\u201D` : "\u4E0D\u4F20 --module"};\u8981\u7CBE\u786E\u5B9A\u4F4D\u8BF7\u663E\u5F0F\u4F20 module\u3002` : "";
      const started = Date.now();
      let output = "";
      let code = null;
      let timedOut = false;
      let note = "";
      try {
        if (buildOnly || skipBuild) {
          const argv = buildOnly ? [process.execPath, cli, "build", ...chosen ? ["--modules", chosen] : []] : [process.execPath, cli, "run", "--device", device, ...chosen ? ["--module", chosen] : [], "--skip-build"];
          const r = await runCli(argv, { cwd: projectPath, timeoutMs: 20 * 60 * 1e3 });
          output = r.output;
          code = r.code;
          timedOut = r.timedOut;
        } else {
          const r = await api.deploy({ projectPath, device, module: chosen });
          output = String(r.output || "");
          code = r.code ?? null;
          timedOut = r.timedOut === true;
          note = r.note;
        }
      } catch (error) {
        const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "internal";
        return { ok: false, device, phase: "build", durationMs: Date.now() - started, errorCode, error: error instanceof Error ? error.message : String(error) };
      }
      const { errors, errorCount, warnCount } = parseBuildErrors(output);
      const ok = code === 0;
      const result = {
        ok,
        code,
        timedOut,
        device: device || null,
        module: chosen || null,
        phase: buildOnly ? "build" : deployPhase(output),
        durationMs: Date.now() - started,
        errors: errors.map((e) => ({ ...e, file: relativeTo(projectPath, e.file) })),
        errorCount,
        warnCount
      };
      const hap = chosen ? hapPathOf(projectPath, chosen) : null;
      if (hap) result.hapPath = hap;
      if (!ok && note) result.note = note;
      if (unreadNote) result.note = result.note ? `${result.note} ${unreadNote}` : unreadNote;
      result.tail = tailText(output, ok ? 6 : 30);
      if (!ok && !buildOnly && device) {
        Object.assign(result, await shotFields(api, device, sessionWorkspace(exec), `deploy-${deployPhase(output)}`, ctx, args?.read === true));
      }
      return result;
    }
  };
  const hmosLog = {
    name: "hmos_log",
    description: "Read recent device logs via devecocli log, parsed into {time, level, tag, message}. Clearing the buffer is a device command (hdc: hilog -r).",
    parameters: {
      type: "object",
      properties: {
        bundle: { type: "string", description: "bundle name filter" },
        level: { type: "string", enum: ["D", "I", "W", "E", "F"], description: "level filter" },
        keyword: { type: "string", description: "keyword filter" },
        crash: { type: "boolean", description: "crash logs only" },
        since: { type: "string", description: "only logs from this far back (30s, 5m)" },
        tail: { type: "integer", description: "latest N lines (50, max 500)" },
        raw: { type: "boolean", description: "also return the raw text tail" },
        read: { type: "boolean", description: "crash: attach the screenshot taken with the crash log, not just its path" },
        device: { type: "string", description: "serial (default: first running)" }
      },
      required: []
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args, exec) {
      const cli = resolveDevecoCli();
      if (!cli) return { ok: false, error: "devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI" };
      const device = (typeof args?.device === "string" && args.device.trim() ? args.device.trim() : "") || await firstRunningSerial(cli);
      if (!device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' };
      const tail = Number.isFinite(args?.tail) ? Math.max(1, Math.min(500, args.tail)) : 50;
      const argv = ["log", "--device", device, "--tail", String(tail)];
      if (args?.crash) argv.push("--crash");
      if (typeof args?.level === "string" && args.level) argv.push("--level", String(args.level));
      if (typeof args?.bundle === "string" && args.bundle.trim()) argv.push("--bundle-name", args.bundle.trim());
      if (typeof args?.keyword === "string" && args.keyword.trim()) argv.push("--keyword", args.keyword.trim());
      if (typeof args?.since === "string" && args.since.trim()) argv.push("--from", args.since.trim());
      const r = await runCli([process.execPath, cli, ...argv], { timeoutMs: 6e4 });
      if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 8) };
      const text = r.output.trim();
      const lines = parseLogLines(r.output).slice(-tail);
      const result = { ok: true, device, tail, count: lines.length, lines };
      if (lines.length === 0) result.rawTail = text.length > 2e3 ? text.slice(-2e3) : text;
      else if (args?.raw) result.rawTail = text.length > 8e3 ? text.slice(-8e3) : text;
      if (args?.crash && lines.length > 0) {
        Object.assign(result, await shotFields(api, device, sessionWorkspace(exec), "crash", ctx, args?.read === true));
      }
      return result;
    }
  };
  const hmosDocs = {
    name: "hmos_docs",
    description: "Search/read the official HarmonyOS docs via devecocli docs (offline local set). search: compact id/title/snippet; read: one document, pageable.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "read"] },
        keywords: { type: "string", description: "search: phrase, as-is" },
        open: { type: "integer", description: "search: also read the first N hits in full (1-3), saving the follow-up read" },
        documentId: { type: "string", description: "read: id from a search result" },
        limit: { type: "integer", description: "search: max results (5, max 20); read: max chars (8000, max 20000)" },
        offset: { type: "integer", description: "read: start at this char (0); continue from nextOffset" }
      },
      required: ["action"]
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args) {
      const cli = resolveDevecoCli();
      if (!cli) return { ok: false, error: "devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI" };
      const action = String(args?.action || "");
      if (action === "search") {
        const keywords = typeof args?.keywords === "string" ? args.keywords.trim() : "";
        if (!keywords) return { ok: false, error: "keywords is required" };
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(20, args.limit)) : 5;
        const argv = [process.execPath, cli, "docs", "search", keywords, "--limit", String(limit)];
        const r = await runCli(argv, { timeoutMs: 6e4 });
        if (r.code !== 0) return { ok: false, error: tailText(r.output, 6) };
        const entries = r.output.split(/\n\s*\n/).map((chunk) => {
          const lines = chunk.split(/\r?\n/).filter((line) => line.trim() !== "");
          if (lines.length === 0) return null;
          const id = lines[0].trim();
          if (id.startsWith("Title:") || id.startsWith("Content:")) return null;
          const title = (chunk.match(/Title:\s*(.+)/) || [])[1] || "";
          const content = (chunk.match(/Content:\s*([\s\S]*)/) || [])[1] || "";
          return { id, title: title.trim(), snippet: content.replace(/\s+/g, " ").trim().slice(0, 140) };
        }).filter(Boolean);
        const open = Number.isFinite(args?.open) ? Math.max(0, Math.min(3, Math.floor(args.open))) : 0;
        if (open === 0 || entries.length === 0) return { ok: true, count: entries.length, entries };
        const opened = [];
        for (const entry of entries.slice(0, open)) {
          const read = await runCli([process.execPath, cli, "docs", "read", entry.id], { timeoutMs: 6e4 });
          if (read.code !== 0) {
            opened.push({ id: entry.id, error: tailText(read.output, 3) });
            continue;
          }
          const slice = sliceText(read.output.trim(), 0, 8e3);
          opened.push({
            id: entry.id,
            title: entry.title,
            total: slice.total,
            ...slice.nextOffset === null ? {} : { nextOffset: slice.nextOffset },
            text: slice.text
          });
        }
        return { ok: true, count: entries.length, entries, opened };
      }
      if (action === "read") {
        const documentId = typeof args?.documentId === "string" ? args.documentId.trim() : "";
        if (!documentId) return { ok: false, error: "documentId is required" };
        const r = await runCli([process.execPath, cli, "docs", "read", documentId], { timeoutMs: 6e4 });
        if (r.code !== 0) return { ok: false, error: tailText(r.output, 6) };
        const offset = Number.isFinite(args?.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
        const limit = Number.isFinite(args?.limit) ? Math.max(500, Math.min(2e4, Math.floor(args.limit))) : 8e3;
        const slice = sliceText(r.output.trim(), offset, limit);
        return {
          ok: true,
          documentId,
          total: slice.total,
          offset: slice.offset,
          // Say where to continue instead of dropping the tail silently.
          ...slice.nextOffset === null ? {} : { nextOffset: slice.nextOffset },
          text: slice.text
        };
      }
      return { ok: false, error: `unknown action ${action}` };
    }
  };
  const hmosLint = {
    name: "hmos_lint",
    description: "Run the DevEco code check via devecocli check lint; findings come back structured. changed = uncommitted tracked files under the project, reported as checkedFiles (a non-git project escalates to a full check); new files come back as untrackedFiles (incremental cannot see them); all = whole project.",
    parameters: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "project root (contains build-profile.json5)" },
        scope: { type: "string", enum: ["changed", "all"], description: "changed: --incremental (default) | all" }
      },
      required: ["projectPath"]
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args, exec) {
      const cli = resolveDevecoCli();
      if (!cli) return { ok: false, error: "devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI" };
      const project = projectRootOf(args?.projectPath, exec);
      if (!project) return { ok: false, error: "projectPath is required" };
      if (!existsSync(project)) return { ok: false, error: `\u5E94\u7528\u5DE5\u7A0B\u8DEF\u5F84\u4E0D\u5B58\u5728:${project}` };
      if (!existsSync(join(project, PROJECT_MARK))) {
        return { ok: false, error: `\u672A\u627E\u5230 ${PROJECT_MARK}:\u5DF2\u6309 ${project} \u67E5\u627E(\u4F20\u76EE\u5F55\u65F6\u8BF7\u7ED9\u5DE5\u7A0B\u6839,\u76F8\u5BF9\u8DEF\u5F84\u6309\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u89E3\u6790)\u3002` };
      }
      let full = args?.scope === "all";
      let escalated = false;
      let checkedFiles = null;
      let untrackedFiles = [];
      if (!full) {
        const status = await codeStatusFiles(project);
        const changed = status === null ? null : status.changed;
        untrackedFiles = status === null ? [] : status.untracked;
        const scope = lintScope("changed", changed);
        full = scope.full;
        escalated = scope.escalated;
        checkedFiles = scope.checkedFiles;
      }
      const argv = [process.execPath, cli, "check", "lint", project];
      if (!full) argv.push("--incremental");
      const r = await runCli(argv, { cwd: project, timeoutMs: full ? 6e5 : 3e5 });
      const { findings, summary } = parseLintTable(r.output);
      const bySeverity = (want) => findings.filter((f) => f.severity === want);
      const errors = bySeverity("Error");
      const warnings = bySeverity("Warning");
      const suggestions = bySeverity("Suggestion");
      const outcome = lintOutcome(summary, full ? "all" : "changed", checkedFiles ? checkedFiles.length : null);
      const cap = 40;
      return {
        ok: errors.length === 0,
        code: r.code,
        timedOut: r.timedOut,
        projectPath: project,
        scope: full ? "all" : "changed",
        // What `changed` actually covered, so a caller can tell "checked and clean" from "never
        // looked at it".
        scopeBasis: full ? "all" : "git",
        ...escalated ? { escalated: true, escalatedWhy: "\u975E git \u5DE5\u7A0B\u6216 git \u4E0D\u53EF\u7528,\u5DF2\u81EA\u52A8\u6539\u4E3A\u5168\u91CF\u68C0\u67E5" } : {},
        ...checkedFiles ? { checkedFiles } : {},
        // New files are outside `--incremental` by construction; saying so is the difference between
        // "clean" and "never looked at the file you just added".
        ...untrackedFiles.length > 0 ? {
          untrackedFiles,
          note: `${untrackedFiles.length} \u4E2A\u65B0\u5EFA(\u672A\u8DDF\u8E2A)\u6587\u4EF6\u4E0D\u5728 --incremental \u8986\u76D6\u8303\u56F4\u5185;\u8981\u68C0\u67E5\u5B83\u4EEC\u8BF7\u7528 scope:'all',\u6216\u5148 git add\u3002`
        } : {},
        empty: outcome.empty,
        summary: summary ? { issues: summary.issues, errors: summary.errors, warnings: summary.warnings, suggestions: summary.suggestions, filesChecked: summary.files } : null,
        errors: errors.slice(0, cap),
        warnings: warnings.slice(0, cap),
        suggestions: suggestions.slice(0, cap),
        omitted: {
          errors: Math.max(0, errors.length - cap),
          warnings: Math.max(0, warnings.length - cap),
          suggestions: Math.max(0, suggestions.length - cap)
        },
        stats: outcome.stats,
        rawTail: tailText(r.output, 2)
      };
    }
  };
  return [emu, emuUi, hmosDeploy, hmosLog, hmosDocs, hmosLint];
}
function apply(ctx, _config) {
  try {
    const api = createApi();
    let registered = false;
    let timer = null;
    let disposed = false;
    const registerOnce = () => {
      if (disposed || registered) return;
      try {
        const ws = ctx.get("webServer");
        if (ws === void 0 || typeof ws.register !== "function") {
          timer = setTimeout(registerOnce, 700);
          return;
        }
        registered = true;
        ctx.effect(() => ws.register({
          kind: "prefix",
          path: API_PREFIX,
          handler: async (req, res) => {
            try {
              if (req.method !== "POST") {
                writeJson(res, 405, { ok: false, error: { code: "method", message: "only POST" } });
                return;
              }
              if (!trustRequest(req, fenceAuthorities(ctx.get("webRuntime"), ws.host))) {
                writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "\u8BF7\u6C42\u6765\u6E90\u4E0D\u53EF\u4FE1(Host/Origin \u6821\u9A8C\u672A\u901A\u8FC7)" } });
                return;
              }
              if (!/^application\/json\b/i.test(String(headerValue(req.headers, "content-type") || ""))) {
                writeJson(res, 415, { ok: false, error: { code: "media-type", message: "content-type \u5FC5\u987B\u662F application/json" } });
                return;
              }
              const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
              const method = pathname.slice(API_PREFIX.length).replace(/^\/+/, "").replace(/\/+$/, "");
              const handler = METHODS.has(method) ? api[method] : void 0;
              if (handler === void 0) {
                writeJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown method ${method}` } });
                return;
              }
              let payload = {};
              const text = await readBody(req);
              if (text.trim()) {
                try {
                  payload = JSON.parse(text);
                } catch {
                  writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "body is not valid JSON" } });
                  return;
                }
              }
              if (payload !== null && typeof payload === "object") delete payload["origin"];
              if (STREAMING_METHODS.has(method)) {
                try {
                  await handler(payload, res);
                } catch (error) {
                  if (!res.headersSent) writeError(res, error);
                  else {
                    try {
                      res.write(`
[HMOS_EXIT]=-2
`);
                    } catch {
                    }
                    try {
                      res.end();
                    } catch {
                    }
                  }
                }
                return;
              }
              const value = await handler(payload);
              writeOk(res, value);
            } catch (error) {
              writeError(res, error);
            }
          }
        }), "dsh-hmos-emulator: http api");
      } catch (error) {
        console.error("[dsh-hmos-emulator] \u5BBF\u4E3B\u8DEF\u7531\u6CE8\u518C\u5F02\u5E38(\u5DF2\u9694\u79BB,\u4E0D\u5F71\u54CD DSH):", error);
      }
    };
    registerOnce();
    const defs = createToolDefs(api, ctx);
    let toolsRegistered = false;
    let toolsTimer = null;
    const registerTools = () => {
      if (disposed || toolsRegistered) return;
      try {
        const tools = ctx.get("tools");
        if (tools === void 0 || typeof tools.register !== "function") {
          toolsTimer = setTimeout(registerTools, 700);
          return;
        }
        toolsRegistered = true;
        const disposers = [];
        for (const def of defs) disposers.push(tools.register(def));
        ctx.effect(() => () => {
          for (const d of disposers) {
            try {
              if (typeof d === "function") d();
            } catch {
            }
          }
        }, "dsh-hmos-emulator: model tools");
      } catch (error) {
        console.error("[dsh-hmos-emulator] Model Tool \u6CE8\u518C\u5F02\u5E38(\u5DF2\u9694\u79BB,\u4E0D\u5F71\u54CD DSH):", error);
      }
    };
    registerTools();
    let lintContextRegistered = false;
    let lintTimer = null;
    const registerLintContext = () => {
      if (disposed || lintContextRegistered) return;
      try {
        const sp = ctx.get("systemPrompt");
        if (sp === void 0 || typeof sp.context !== "function") {
          lintTimer = setTimeout(registerLintContext, 700);
          return;
        }
        lintContextRegistered = true;
        ctx.effect(() => sp.context({
          name: "hmos-emulator-code-check",
          order: 990,
          text: (assemble) => {
            if (!lintNotice || lintDeliveries >= 1) return "";
            const agents = ctx.get("agents");
            if (lintNoticeSession && agents && typeof agents.get === "function") {
              const owner = agents.get(lintNoticeSession);
              if (owner !== void 0 && assemble?.scope !== owner) return "";
            }
            lintDeliveries += 1;
            return lintNotice;
          }
        }), "dsh-hmos-emulator: code-check context");
      } catch (error) {
        console.error("[dsh-hmos-emulator] \u68C0\u67E5\u7ED3\u679C\u4E0A\u4E0B\u6587\u6CE8\u518C\u5F02\u5E38(\u5DF2\u9694\u79BB,\u4E0D\u5F71\u54CD DSH):", error);
      }
    };
    registerLintContext();
    ctx.effect(() => () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (toolsTimer) clearTimeout(toolsTimer);
      if (lintTimer) clearTimeout(lintTimer);
    });
  } catch (error) {
    console.error("[dsh-hmos-emulator] \u5BBF\u4E3B apply \u5F02\u5E38(\u5DF2\u9694\u79BB,\u4E0D\u5F71\u54CD DSH \u542F\u52A8):", error);
  }
}
export {
  AUTO_SHOT_PREFIX,
  SHOT_KEEP,
  TOOL_SHOT_PREFIX,
  ancestorLabels,
  apply,
  attachmentRefForImage,
  capLines,
  changedCodeFiles,
  cliFromWrapper,
  cropPng,
  decodePng,
  deployPhase,
  devecoCliHint,
  diffLines,
  diffPng,
  encodePng,
  fenceAuthorities,
  fixStats,
  labelMatches,
  layoutJson,
  lintOutcome,
  lintScope,
  name,
  nodeLabel,
  pageTitle,
  parseBuildErrors,
  parseLayoutLine,
  parseLintTable,
  parseLogLines,
  pruneAutoShots,
  pruneToolShots,
  sessionWorkspace,
  sliceText,
  stepSummary,
  trustRequest,
  untrackedCodeFiles
};
