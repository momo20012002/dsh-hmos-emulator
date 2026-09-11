import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
const name = "dsh-hmos-emulator";
const API_PREFIX = "/dsh-hmos-emulator/api";
const METHODS = /* @__PURE__ */ new Set([
  "toolchain",
  "emu.list",
  "emu.start",
  "emu.stop",
  "devices",
  "browse",
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
function resolveDevecoCli() {
  const explicit = process.env.DSH_HMOS_DEVECO_CLI || "";
  if (explicit && existsSync(explicit)) return explicit;
  const shim = whichFirst("devecocli");
  if (shim) {
    for (const line of [shim]) {
      const dir = dirname(line);
      const cli2 = cliUnderNpmRoot(dir);
      if (cli2) return cli2;
    }
    const parent = dirname(shim);
    const cli = cliUnderNpmRoot(parent);
    if (cli) return cli;
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
function listDirs(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw Object.assign(new Error(`\u65E0\u6CD5\u8BFB\u53D6\u76EE\u5F55:${error instanceof Error ? error.message : String(error)}`), { code: "fs-error" });
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    if (result.length >= 300) break;
    result.push({
      name: entry.name,
      isProject: existsSync(join(dir, entry.name, PROJECT_MARK))
    });
  }
  result.sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name));
  return result;
}
function scanProjects(root, maxDepth = 3) {
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
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3').replace(/,\s*([}\]])/g, "$1");
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
let lintDeliveries = 0;
function createApi(config) {
  const api = {};
  api.toolchain = async () => {
    const sdk = process.env.DEVECO_SDK_HOME || config?.sdkHome || "";
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
      hint: `devecocli \u7F3A\u5931\u65F6:\u5B89\u88C5 @deveco/deveco-cli \u6216\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF DSH_HMOS_DEVECO_CLI\u3002hdc \u7F3A\u5931\u65F6:\u8BBE\u7F6E DEVECO_SDK_HOME(${sdkExample})\u540E\u91CD\u542F dsh web\u3002`
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
    const argv = [process.execPath, cli, "emulator", "start", name2];
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) argv.push("-noWindow");
    const result = await runCli(argv, { timeoutMs: 24e4 });
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
  api.browse = async (payload) => {
    const root = normalizeDir(payload?.path);
    return {
      root,
      parent: dirname(root) === root ? null : dirname(root),
      dirs: listDirs(root)
    };
  };
  api.scan = async (payload) => {
    const root = normalizeDir(payload?.root);
    const paths = scanProjects(root);
    return { root, projects: paths };
  };
  api["project.info"] = async (payload) => {
    const project = typeof payload?.projectPath === "string" ? resolve(payload.projectPath) : "";
    if (!project || !existsSync(project)) throw Object.assign(new Error("\u5E94\u7528\u5DE5\u7A0B\u8DEF\u5F84\u4E0D\u5B58\u5728"), { code: "bad-request" });
    return { modules: readModules(project) };
  };
  api["check.lint"] = async (payload) => {
    const cli = resolveDevecoCli();
    if (!cli) throw Object.assign(new Error("\u672A\u627E\u5230 devecocli(\u89C1\u5DE5\u5177\u94FE\u63D0\u793A)"), { code: "toolchain" });
    const project = typeof payload?.projectPath === "string" ? resolve(payload.projectPath) : "";
    if (!project || !existsSync(project)) throw Object.assign(new Error("\u5E94\u7528\u5DE5\u7A0B\u8DEF\u5F84\u4E0D\u5B58\u5728"), { code: "bad-request" });
    const asked = payload?.mode;
    const fixing = asked === "fix" || asked === "fix-all";
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
  api["lint.notify"] = async () => {
    if (!lastLintNotice) throw Object.assign(new Error("\u5C1A\u672A\u751F\u6210\u68C0\u67E5\u7ED3\u679C,\u8BF7\u5148\u6267\u884C\u4EE3\u7801\u68C0\u67E5"), { code: "bad-request" });
    lintNotice = lastLintNotice;
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
    const chosen = payload?.module ? String(payload.module) : modules.includes("entry") ? "entry" : modules[0];
    const cmd = [process.execPath, cli, "run", "--device", device];
    if (chosen) cmd.push("--module", chosen);
    const note = (code) => code === 0 ? "\u6784\u5EFA\u3001\u5B89\u88C5\u3001\u542F\u52A8\u5B8C\u6210\u3002(hvigor \u7684 \u201CNo signingConfigs\u201D \u53EA\u662F\u8B66\u544A,\u6A21\u62DF\u5668\u53EF\u88C5\u672A\u7B7E\u540D debug \u5305)" : "\u90E8\u7F72\u5931\u8D25,\u8BF7\u67E5\u770B\u4E0A\u65B9\u8F93\u51FA;\u5E38\u89C1\u539F\u56E0:\u7B7E\u540D\u672A\u914D\u7F6E / \u8BBE\u5907\u672A\u5C31\u7EEA\u3002";
    if (res && typeof res.write === "function") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache, no-transform" });
      res.write(`[dsh-hmos-emulator] \u90E8\u7F72 ${device}${chosen ? `(\u6A21\u5757 ${chosen})` : ""}
`);
      const { code, timedOut } = await runCliStream(cmd, {
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
    const file = join(dir, `hmos-shot-${Date.now()}-${safe}.png`);
    const result = await runCli([process.execPath, cli, "ui", "screenshot", "--device", device, "--path", file], { timeoutMs: 6e4 });
    if (result.code !== 0 || !existsSync(file)) {
      const why = result.timedOut ? "\u8D85\u65F6" : result.code === 0 ? "\u672A\u751F\u6210\u6587\u4EF6" : `\u9000\u51FA\u7801 ${result.code}`;
      throw new Error(`\u622A\u56FE\u5931\u8D25(${why}):
${result.output}`);
    }
    return { path: file, device, dataUrl: payload?.preview ? readDataUrl(file) : null };
  };
  return api;
}
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, c) => sum + c.length, 0) > 1e6) {
        rejectBody(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
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
  const status = code === "bad-request" || code === "toolchain" || code === "fs-error" || code === "image-missing" ? 400 : 500;
  writeJson(res, status, { ok: false, error: { code, message } });
}
const TOOL_OUT_SCHEMA = { type: "object", additionalProperties: true };
const toolRender = (args, value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
function headText(text, n) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(0, n).join("\n");
}
function tailText(text, n) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(-n).join("\n");
}
async function countChangedCode(project) {
  const r = await runCli(["git", "status", "--porcelain", "--", "."], { cwd: project, timeoutMs: 15e3 });
  if (r.code !== 0) return null;
  return r.output.split(/\r?\n/).filter((l) => !l.startsWith("??") && /\.(ets|ts|js)$/.test(l)).length;
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
function createToolDefs(api) {
  const emu = {
    name: "emu",
    description: "List/start/stop HarmonyOS emulators via devecocli (start pre-checks the system image and waits until online).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "start", "stop"], description: "list | start (waits online) | stop" },
        name: { type: "string", description: "Instance name (required for start/stop)" }
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
        const argv = [process.execPath, cli, "emulator", "start", name2];
        if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) argv.push("-noWindow");
        const r = await runCli(argv, { timeoutMs: 24e4 });
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
  const emuUi = {
    name: "emu_ui",
    description: 'Drive the emulator screen via devecocli ui: layout (compact tree lines: type [x1,y1,x2,y2] "text" clickable), click (by label -> auto-locates and taps its center; or x/y), text, swipe, screenshot (saves a PNG; view with read_image).',
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["layout", "click", "text", "swipe", "screenshot"], description: "UI action" },
        device: { type: "string", description: "Target serial (default: first running emulator)" },
        label: { type: "string", description: "click: node text; runs layout and taps that center in one call" },
        thenLayout: { type: "boolean", description: "click: return a fresh layout after the tap (verifies in one call)" },
        waitMs: { type: "integer", description: "thenLayout delay, ms (default 600, max 5000)" },
        x: { type: "integer", description: "click x, or swipe start x" },
        y: { type: "integer", description: "click y, or swipe start y" },
        x2: { type: "integer", description: "swipe end x" },
        y2: { type: "integer", description: "swipe end y" },
        text: { type: "string", description: "text to input" },
        root: { type: "string", description: "screenshot root; PNG goes to <root>/screenshots (default: cwd)" }
      },
      required: ["action"]
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args) {
      const cli = resolveDevecoCli();
      if (!cli) return { ok: false, error: "devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI" };
      const action = String(args?.action || "");
      const device = (typeof args?.device === "string" && args.device.trim() ? args.device.trim() : "") || await firstRunningSerial(cli);
      if (!device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' };
      const run = (argv, timeoutMs) => runCli([process.execPath, cli, ...argv], { timeoutMs });
      if (action === "layout") {
        const argv = ["ui", "layout", "--device", device];
        const r = await run(argv, 3e4);
        if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 6) };
        const tree = r.output.split(/\r?\n/).filter((l) => l.trim() !== "" && !/Dumping layout/i.test(l)).join("\n");
        return { ok: true, device, tree: tree.length > 6e3 ? `${tree.slice(0, 6e3)}
\u2026(truncated; pass depth to narrow)` : tree };
      }
      if (action === "click") {
        let argv = ["ui", "click", "--device", device];
        let point = null;
        let matched = "";
        if (Number.isFinite(args?.x) && Number.isFinite(args?.y)) {
          point = { x: args.x, y: args.y };
          argv.push(String(args.x), String(args.y));
        } else if (typeof args?.label === "string" && args.label.trim()) {
          const lr = await run(["ui", "layout", "--device", device], 3e4);
          if (lr.code !== 0) return { ok: false, device, error: tailText(lr.output, 6) };
          const line = lr.output.split(/\r?\n/).find((l) => l.includes(args.label));
          const m = line ? line.match(/\[(\d+),(\d+),(\d+),(\d+)\]/) : null;
          if (!m) return { ok: false, device, error: `no layout node matching "${args.label}"` };
          point = { x: Math.round((Number(m[1]) + Number(m[3])) / 2), y: Math.round((Number(m[2]) + Number(m[4])) / 2) };
          matched = line.trim();
          argv = ["ui", "click", String(point.x), String(point.y), "--device", device];
        } else return { ok: false, error: "click needs label or x/y" };
        const r = await run(argv, 2e4);
        if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 4) };
        const result = { ok: true, device, x: point.x, y: point.y };
        if (matched) result.matched = matched;
        if (args?.thenLayout) {
          const wait = Number.isFinite(args?.waitMs) ? Math.max(0, Math.min(5e3, args.waitMs)) : 600;
          if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
          const after = await run(["ui", "layout", "--device", device], 3e4);
          result.tree = after.code === 0 ? after.output.split(/\r?\n/).filter((l) => l.trim() !== "" && !/Dumping layout/i.test(l)).join("\n") : tailText(after.output, 4);
        }
        return result;
      }
      if (action === "text") {
        const value = typeof args?.text === "string" ? args.text : "";
        if (!value) return { ok: false, error: "text is required" };
        const r = await run(["ui", "text", value, "--device", device], 2e4);
        return { ok: r.code === 0, device, error: r.code === 0 ? "" : tailText(r.output, 4) };
      }
      if (action === "swipe") {
        if (![args?.x, args?.y, args?.x2, args?.y2].every((n) => Number.isFinite(n))) return { ok: false, error: "swipe needs x, y, x2, y2" };
        const r = await run(["ui", "swipe", String(args.x), String(args.y), String(args.x2), String(args.y2), "--device", device], 2e4);
        return { ok: r.code === 0, device, error: r.code === 0 ? "" : tailText(r.output, 4) };
      }
      if (action === "screenshot") {
        const root = typeof args?.root === "string" && args.root.trim() ? args.root.trim() : process.cwd();
        const value = await api.screenshot({ device, root });
        return { ok: true, path: value.path, device: value.device };
      }
      return { ok: false, error: `unknown action ${action}` };
    }
  };
  const hmosDeploy = {
    name: "hmos_deploy",
    description: "Build and deploy a project to a running emulator (devecocli run: build -> install -> launch). Returns a short note plus the output tail, not the full hvigor log.",
    parameters: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Project root (must contain build-profile.json5)" },
        device: { type: "string", description: "Target serial (default: first running emulator)" },
        module: { type: "string", description: "Entry module (default: entry)" }
      },
      required: ["projectPath"]
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args) {
      const cli = resolveDevecoCli();
      if (!cli) return { ok: false, error: "devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI" };
      const projectPath = typeof args?.projectPath === "string" ? args.projectPath.trim() : "";
      if (!projectPath) return { ok: false, error: "projectPath is required" };
      const device = (typeof args?.device === "string" && args.device.trim() ? args.device.trim() : "") || await firstRunningSerial(cli);
      if (!device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' };
      try {
        const r = await api.deploy({ projectPath, device, module: args?.module });
        return { ok: r.code === 0, code: r.code ?? null, timedOut: r.timedOut === true, device, note: r.note, tail: tailText(r.output, 30) };
      } catch (error) {
        return { ok: false, device, error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  const hmosLog = {
    name: "hmos_log",
    description: "Read recent device logs via devecocli log: filter by bundle/level/keyword or crash-only, and return only the tail (default 50 lines). Covers crash + hilog without hdc.",
    parameters: {
      type: "object",
      properties: {
        bundle: { type: "string", description: "Filter by bundle name" },
        level: { type: "string", enum: ["D", "I", "W", "E", "F"], description: "Log level filter" },
        keyword: { type: "string", description: "Keyword filter" },
        crash: { type: "boolean", description: "Only crash logs" },
        tail: { type: "integer", description: "Latest N lines (default 50, max 500)" },
        device: { type: "string", description: "Target serial (default: first running emulator)" }
      },
      required: []
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args) {
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
      const r = await runCli([process.execPath, cli, ...argv], { timeoutMs: 6e4 });
      if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 8) };
      const text = r.output.trim();
      return { ok: true, device, tail, text: text.length > 8e3 ? text.slice(-8e3) : text };
    }
  };
  const hmosDocs = {
    name: "hmos_docs",
    description: "Search and read the official HarmonyOS docs via devecocli docs (local official doc set, works offline). search returns compact entries (id/title/140-char snippet); read returns one document (truncated).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "read"], description: "search | read" },
        keywords: { type: "string", description: "search: keywords, pass the phrase as-is" },
        documentId: { type: "string", description: "read: id from a search result" },
        limit: { type: "integer", description: "search: max results (default 5, max 20)" }
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
        return { ok: true, count: entries.length, entries };
      }
      if (action === "read") {
        const documentId = typeof args?.documentId === "string" ? args.documentId.trim() : "";
        if (!documentId) return { ok: false, error: "documentId is required" };
        const r = await runCli([process.execPath, cli, "docs", "read", documentId], { timeoutMs: 6e4 });
        if (r.code !== 0) return { ok: false, error: tailText(r.output, 6) };
        const text = r.output.trim();
        return { ok: true, documentId, text: text.length > 14e3 ? `${text.slice(0, 14e3)}
\u2026(truncated)` : text };
      }
      return { ok: false, error: `unknown action ${action}` };
    }
  };
  return [emu, emuUi, hmosDeploy, hmosLog, hmosDocs];
}
function apply(ctx, config) {
  try {
    const api = createApi(config ?? {});
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
    const defs = createToolDefs(api);
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
          text: () => {
            if (!lintNotice || lintDeliveries >= 1) return "";
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
  apply,
  fixStats,
  lintOutcome,
  name
};
