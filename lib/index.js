import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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
  "deploy",
  "deveco.install"
]);
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
function createApi(config) {
  const api = {};
  api.toolchain = async () => {
    const sdk = process.env.DEVECO_SDK_HOME || config?.sdkHome || "";
    const sdkExample = process.platform === "win32" ? "\u5982 C:\\Program Files\\Huawei\\DevEco Studio\\sdk" : "\u6307\u5411\u672C\u673A\u5B89\u88C5\u7684 DevEco Studio SDK \u76EE\u5F55(\u4EE5\u5B9E\u9645\u5B89\u88C5\u4E3A\u51C6)";
    return {
      platform: process.platform,
      home: homedir(),
      node: process.execPath,
      devecoCliJs: resolveDevecoCli() ?? null,
      hdcExe: resolveHdc() ?? null,
      sdkHome: sdk || null,
      hint: `devecocli \u7F3A\u5931\u65F6:\u5B89\u88C5 @deveco/deveco-cli \u6216\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF DSH_HMOS_DEVECO_CLI\u3002hdc \u7F3A\u5931\u65F6:\u8BBE\u7F6E DEVECO_SDK_HOME(${sdkExample})\u540E\u91CD\u542F dsh web\u3002`
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
    const result = await runCli([process.execPath, cli, "emulator", "start", name2], { timeoutMs: 24e4 });
    return { code: result.code, timedOut: result.timedOut, output: result.output };
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
  api.deploy = async (payload) => {
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
        throw Object.assign(new Error(`\u8BBE\u5907 ${device} \u5F53\u524D\u672A\u5728\u7EBF\u2014\u2014\u8BF7\u5148\u70B9\u201C\u25B6 \u542F\u52A8\u201D\u6A21\u62DF\u5668(\u6216\u8FDE\u63A5\u8BBE\u5907),\u518D\u70B9\u201C\u626B\u63CF\u53EF\u7528\u201D\u540E\u91CD\u8BD5`), { code: "device-offline" });
      }
    }
    const result = await runCli(
      [process.execPath, cli, "run", "--device", device],
      { cwd: project, timeoutMs: 20 * 60 * 1e3 }
    );
    return {
      code: result.code,
      timedOut: result.timedOut,
      output: result.output,
      note: result.code === 0 ? "\u6784\u5EFA\u3001\u5B89\u88C5\u3001\u542F\u52A8\u5B8C\u6210\u3002(hvigor \u7684 \u201CNo signingConfigs\u201D \u53EA\u662F\u8B66\u544A,\u6A21\u62DF\u5668\u53EF\u88C5\u672A\u7B7E\u540D debug \u5305)" : "\u90E8\u7F72\u5931\u8D25,\u8BF7\u67E5\u770B\u4E0A\u65B9\u8F93\u51FA;\u5E38\u89C1\u539F\u56E0:\u7B7E\u540D\u672A\u914D\u7F6E / \u591A\u4E2A entry \u6A21\u5757(\u9700\u6307\u5B9A --module)/ \u8BBE\u5907\u672A\u5C31\u7EEA\u3002"
    };
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
  const status = code === "bad-request" || code === "toolchain" || code === "fs-error" ? 400 : 500;
  writeJson(res, status, { ok: false, error: { code, message } });
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
    ctx.effect(() => () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    });
  } catch (error) {
    console.error("[dsh-hmos-emulator] \u5BBF\u4E3B apply \u5F02\u5E38(\u5DF2\u9694\u79BB,\u4E0D\u5F71\u54CD DSH \u542F\u52A8):", error);
  }
}
export {
  apply,
  name
};
