window.__ModuleLoader__.load({ id: "dsh-hmos-emulator", factory: (require) => { const module = { exports: {} }; const exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
const { createElement: h, useEffect, useRef, useState } = require("react");
const svg = (vb, body) => `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" fill="currentColor">${body}</svg>`;
const IC = {
  emulator: svg("0 0 1024 1024", '<path d="M768 264.32c-21.12-11.52-42.24-21.76-64-28.8-30.72-11.52-61.44-18.56-91.52-17.92h-3.2c-159.36 3.84-348.8 187.52-348.8 223.36 0 36.48 176.64 227.2 352 224.64 30.656-0.704 61.44-7.04 91.52-17.344 21.76-7.68 43.52-17.28 64-28.8 111.36-59.52 196.48-159.36 196.48-178.56 0-18.496-88.96-116.416-196.48-176.576z m0 214.4c-9.6 35.2-32.64 65.28-64 85.12-25.6 17.28-57.6 26.88-91.52 26.88-88.96 0-160.64-67.2-160.64-149.76s71.68-149.12 160.64-149.12c33.92 0 65.92 9.6 91.52 26.88 31.36 19.84 54.4 49.92 64 85.12a140.544 140.544 0 0 1 0 74.88z"/><path d="M546.944 441.728c0 33.408 28.864 60.608 65.28 60.608 35.904 0 65.152-27.2 65.152-60.608 0-33.6-29.248-60.608-65.152-60.608-36.416 0-65.28 26.944-65.28 60.608z"/><path d="M768 128.64V128c0-35.2-28.8-64-64-64H192c-35.2 0-64 28.8-64 64v768c0 35.2 28.8 64 64 64h512c35.2 0 64-28.8 64-64v-192H192V183.04c0-30.08 23.04-55.04 51.2-55.04M448 771.84c24.96 0 44.8 20.48 44.8 45.44 0 24.384-19.84 44.8-44.8 44.8s-44.8-20.416-44.8-44.8c0-24.96 19.84-45.44 44.8-45.44z m320-535.04v-1.28h-2.56c0.64 0.64 1.92 0.64 2.56 1.28z"/>'),
  play: svg("0 0 1024 1024", '<path d="M320 256l448 256-448 256V256z"/>'),
  stop: svg("0 0 1024 1024", '<path d="M300 232h424a68 68 0 0 1 68 68v424a68 68 0 0 1-68 68H300a68 68 0 0 1-68-68V300a68 68 0 0 1 68-68z"/>'),
  refresh: svg("0 0 1024 1024", '<path d="M511.582491 63.413262C265.134543 63.413262 64.62588 263.921925 64.62588 510.369873s200.508663 446.957635 446.957635 446.957635 446.957635-200.508663 446.957635-446.957635S758.031463 63.413262 511.582491 63.413262zM509.001713 751.859903c-98.517781 0-182.467775-62.623269-214.771505-150.056598l0.327458-0.134053c-2.007727-4.036943-3.38305-8.422833-3.38305-13.237489 0-16.647145 13.494339-30.142507 30.142507-30.142507 13.389962 0 24.358781 8.877181 28.2893 20.955264l0.422625-0.172939c23.269983 65.442478 85.645612 112.503307 158.972665 112.503307 93.106538 0 168.845523-75.738985 168.845523-168.845523s-75.738985-168.845523-168.845523-168.845523c-20.432355 0-39.874149 3.980661-58.013275 10.66899l21.248953 40.742936c2.486634 2.677992 4.0175 6.2831 4.0175 10.243295 0 8.417717-8.404414 14.921851-15.365966 15.07023-0.102331 0-0.206708 0-0.309038 0-0.220011 0-0.427742 0-0.647753-0.013303l-150.579507-6.463202c-5.372358-0.234337-10.229992-3.310396-12.716626-8.093329-2.486634-4.76963-2.236947-10.509355 0.647753-15.055904l80.890308-127.179564c2.8847-4.533246 8.006348-7.151887 13.365402-6.960529 5.372358 0.234337 10.227945 3.312442 12.71458 8.095375l18.580171 35.625382c26.629497-10.855232 55.683207-16.963347 86.168522-16.963347 126.338407 0 229.130537 102.791108 229.130537 229.130537S635.340119 751.859903 509.001713 751.859903z"/>'),
  scan: svg("0 0 1024 1024", '<path d="M128 384V160c0-17.6 14.4-32 32-32h224v64H192v192h-64z m512-192h192v192h64V160c0-17.6-14.4-32-32-32H640v64z m192 448v192H640v64h224c17.6 0 32-14.4 32-32V640h-64z m-448 192H192V640h-64v224c0 17.6 14.4 32 32 32h224v-64z m512-352H128v64h768v-64z"/>'),
  deploy: svg("0 0 1024 1024", '<path d="M576 64L256 576h176L352 960l352-512H512l64-384z"/>'),
  folder: svg("0 0 1024 1024", '<path d="M855.04 385.024q19.456 2.048 38.912 10.24t33.792 23.04 21.504 37.376 2.048 54.272q-2.048 8.192-8.192 40.448t-14.336 74.24-18.432 86.528-19.456 76.288q-5.12 18.432-14.848 37.888t-25.088 35.328-36.864 26.112-51.2 10.24l-567.296 0q-21.504 0-44.544-9.216t-42.496-26.112-31.744-40.96-12.288-53.76l0-439.296q0-62.464 33.792-97.792t95.232-35.328l503.808 0q22.528 0 46.592 8.704t43.52 24.064 31.744 35.84 12.288 44.032l0 11.264-53.248 0q-40.96 0-95.744-0.512t-116.736-0.512-115.712-0.512-92.672-0.512l-47.104 0q-26.624 0-41.472 16.896t-23.04 44.544q-8.192 29.696-18.432 62.976t-18.432 61.952q-10.24 33.792-20.48 65.536-2.048 8.192-2.048 13.312 0 17.408 11.776 29.184t29.184 11.776q31.744 0 43.008-39.936l54.272-198.656q133.12 1.024 243.712 1.024l286.72 0z"/>'),
  clock: svg("0 0 1024 1024", '<path d="M511.913993 63.989249c-247.012263 0-447.924744 200.912481-447.924744 447.924744s200.912481 447.924744 447.924744 447.924744 447.924744-200.912481 447.924744-447.924744S758.926256 63.989249 511.913993 63.989249zM511.913993 895.677474c-211.577356 0-383.763481-172.186125-383.763481-383.763481 0-211.577356 172.014111-383.763481 383.763481-383.763481s383.763481 172.014111 383.763481 383.763481S723.491349 895.677474 511.913993 895.677474z"/><path d="M672.05913 511.913993l-159.973123 0L512.086007 288.123635c0-17.717453-14.277171-32.166639-31.994625-32.166639-17.717453 0-31.994625 14.449185-31.994625 32.166639l0 255.956996c0 17.717453 14.277171 31.994625 31.994625 31.994625l191.967747 0c17.717453 0 32.166639-14.277171 32.166639-31.994625C704.053754 526.191164 689.604569 511.913993 672.05913 511.913993z"/>'),
  chevron: svg("0 0 1024 1024", '<path d="M256 384l256 256 256-256H256z"/>'),
  camera: svg("0 0 1024 1024", '<path d="M928 256H768l-64-96a64 64 0 0 0-53-28H373a64 64 0 0 0-53 28l-64 96H96a64 64 0 0 0-64 64v512a64 64 0 0 0 64 64h832a64 64 0 0 0 64-64V320a64 64 0 0 0-64-64zM512 800a224 224 0 1 1 0-448 224 224 0 0 1 0 448z m0-352a128 128 0 1 0 0 256 128 128 0 0 0 0-256z"/>')
};
const API = "/dsh-hmos-emulator/api";
async function rpc(method, body) {
  let res;
  try {
    res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body === void 0 ? {} : body)
    });
  } catch (error) {
    throw new Error(`\u65E0\u6CD5\u8FDE\u63A5\u5BBF\u4E3B\u7AEF:${error instanceof Error ? error.message : String(error)}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`\u5BBF\u4E3B\u8FD4\u56DE\u975E JSON(HTTP ${res.status})`);
  }
  if (json && json.ok === true) return json.value;
  const message = json && json.error && json.error.message ? json.error.message : `HTTP ${res.status}`;
  throw new Error(message);
}
const LINT_TITLES = { changed: "\u68C0\u67E5\u6539\u52A8", all: "\u5168\u91CF\u68C0\u67E5", fix: "\u81EA\u52A8\u4FEE\u590D", "fix-all": "\u5168\u91CF\u4FEE\u590D" };
const fmtDur = (ms) => {
  const sec = Math.max(0, Math.round(ms / 1e3));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
};
const s = {
  fg: "var(--dsh-fg, #e6e6e6)",
  muted: "var(--dsh-muted, rgba(148,148,160,.9))",
  faint: "rgba(148,148,160,.7)",
  border: "var(--dsh-border, rgba(148,148,160,.18))",
  bg: "rgba(148,148,160,.05)",
  bg2: "rgba(148,148,160,.03)",
  accent: "var(--dsh-accent, #4f6ef7)",
  accentSoft: "rgba(79,110,247,.16)",
  ok: "var(--dsh-success, #2f9e44)",
  danger: "var(--dsh-danger, #e5484d)",
  solid: "#1d1f28"
};
const row = { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" };
const label = { fontSize: 12, color: s.muted, width: 64, flex: "0 0 64px" };
const field = {
  flex: 1,
  minWidth: 0,
  background: s.bg2,
  color: s.fg,
  border: `1px solid ${s.border}`,
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 12,
  fontFamily: 'ui-monospace, Consolas, "Courier New", monospace'
};
const card = { background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10, padding: 10, marginBottom: 12 };
const btnBase = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 12,
  lineHeight: 1,
  cursor: "pointer",
  border: `1px solid transparent`,
  whiteSpace: "nowrap"
};
const btnPrimary = { ...btnBase, background: s.accent, color: "#fff" };
const btnSecondary = { ...btnBase, border: `1px solid ${s.border}`, color: s.fg, background: "transparent" };
const btnGhost = { ...btnBase, color: s.muted, background: "transparent" };
const btnDanger = { ...btnBase, border: `1px solid ${s.danger}`, color: s.danger, background: "transparent" };
const btnDangerSolid = { ...btnBase, background: s.danger, color: "#fff" };
const logLine = (kind) => ({
  fontSize: 11,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  color: s.fg
});
const warnBox = { background: "rgba(229,72,77,.12)", border: `1px solid ${s.danger}`, color: s.danger, borderRadius: 8, padding: 8, fontSize: 12, marginBottom: 10, lineHeight: 1.5 };
function Icon({ src, size = 16 }) {
  const body = String(src).replace(/fill="[^"]*"/g, 'fill="currentColor"');
  return h("span", {
    style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, flex: "0 0 auto" },
    dangerouslySetInnerHTML: { __html: body }
  });
}
function Btn({ children, icon, primary, secondary, danger, dangerSolid, ghost, disabled, onClick, style, title }) {
  const base = primary ? btnPrimary : secondary ? btnSecondary : dangerSolid ? btnDangerSolid : danger ? btnDanger : ghost ? btnGhost : btnSecondary;
  return h("button", {
    style: { ...base, ...style, ...disabled ? { opacity: 0.5, cursor: "not-allowed" } : void 0 },
    disabled,
    onClick,
    title
  }, icon ? h(Icon, { src: icon, size: 15 }) : null, children);
}
function Card({ title, action, style, children }) {
  return h(
    "div",
    { style: { ...card, ...style } },
    title || action ? h(
      "div",
      { style: { display: "flex", alignItems: "center", marginBottom: 8 } },
      title ? h("span", { style: { fontSize: 11, color: s.muted, letterSpacing: ".06em", textTransform: "uppercase" } }, title) : null,
      h("div", { style: { flex: 1 } }),
      action || null
    ) : null,
    children
  );
}
function Dropdown({ value, placeholder, options, onChange }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return h(
    "div",
    { style: { position: "relative", flex: 1, minWidth: 0 } },
    h(
      "div",
      { style: { position: "relative" } },
      h(
        "button",
        {
          style: { ...field, display: "flex", alignItems: "center", gap: 8, textAlign: "left", color: s.fg, cursor: "pointer", width: "100%" },
          onClick: () => setOpen((o) => !o)
        },
        h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: current ? s.fg : s.faint } }, current ? current.label : placeholder || "\u9009\u62E9\u2026"),
        h("span", { style: { display: "inline-flex", color: s.faint, transform: open ? "rotate(180deg)" : "none", transition: "transform .12s" } }, h(Icon, { src: IC.chevron, size: 14 }))
      ),
      open ? h(
        "div",
        { style: {
          position: "absolute",
          zIndex: 10,
          left: 0,
          right: 0,
          top: "calc(100% + 4px)",
          background: s.solid,
          border: `1px solid ${s.border}`,
          borderRadius: 8,
          padding: 4,
          boxShadow: "0 8px 24px rgba(0,0,0,.45)",
          maxHeight: 220,
          overflowY: "auto"
        } },
        options.length === 0 ? h("div", { style: { padding: "7px 8px", fontSize: 12, color: s.faint } }, "\u65E0\u53EF\u9009\u9879") : options.map((o) => h(
          "div",
          {
            key: o.value,
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              borderRadius: 6,
              cursor: "pointer",
              background: o.value === value ? s.accentSoft : "transparent",
              color: s.fg
            },
            onClick: () => {
              onChange(o.value);
              setOpen(false);
            },
            onMouseEnter: (e) => {
              e.currentTarget.style.background = s.accentSoft;
            },
            onMouseLeave: (e) => {
              e.currentTarget.style.background = o.value === value ? s.accentSoft : "transparent";
            }
          },
          o.status ? h("span", { style: { width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto", background: o.status === "running" ? s.ok : s.faint, boxShadow: "0 0 0 1px rgba(0,0,0,.25)" }, title: o.status }) : null,
          h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 } }, o.label)
        ))
      ) : null
    ),
    open ? h("div", { style: { position: "fixed", inset: 0, zIndex: 9 }, onClick: () => setOpen(false) }) : null
  );
}
let lastShot = null;
function Panel(props) {
  const { scope, ctx } = props;
  const LS_PREFIX = "dsh-hmos-emulator:";
  const lsGet = (k) => {
    try {
      return localStorage.getItem(LS_PREFIX + k) || "";
    } catch {
      return "";
    }
  };
  const lsSet = (k, v) => {
    try {
      localStorage.setItem(LS_PREFIX + k, v);
    } catch {
    }
  };
  const lsSessionKey = (k) => scope && scope.sessionId ? `${k}:${scope.sessionId}` : k;
  const lsModuleKey = (p) => p ? `module:${p}` : "module";
  const [tc, setTc] = useState(null);
  const [tcMsg, setTcMsg] = useState("");
  const [project, setProject] = useState(() => lsGet(lsSessionKey("project")));
  const [scanRoot, setScanRoot] = useState(() => lsGet(lsSessionKey("scanRoot")) || scope && scope.cwd || "");
  const scopeCwd = scope && scope.cwd || "";
  const scanRootEdited = useRef(false);
  const [projectOptions, setProjectOptions] = useState([]);
  const [modules, setModules] = useState([]);
  const [moduleSel, setModuleSel] = useState(() => lsGet(lsModuleKey(project)));
  const [emuRaw, setEmuRaw] = useState("");
  const [emuTarget, setEmuTarget] = useState("");
  const [instances, setInstances] = useState([]);
  const [instanceSel, setInstanceSel] = useState(() => lsGet("instance"));
  const [shot, setShotState] = useState(lastShot);
  const [copied, setCopied] = useState(false);
  const [lintReady, setLintReady] = useState(false);
  const [fixReady, setFixReady] = useState({ changed: false, all: false });
  const [lintSec, setLintSec] = useState(0);
  const [shotView, setShotView] = useState({ zoom: 1, x: 0, y: 0 });
  const shotBoxRef = useRef(null);
  const setShot = (v) => {
    lastShot = v;
    setShotState(v);
  };
  const [showRaw, setShowRaw] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualSerial, setManualSerial] = useState("");
  const [manualType, setManualType] = useState("");
  const [manualOs, setManualOs] = useState("");
  const selInst = instances.find((it) => it.name === instanceSel);
  const toggleManual = () => {
    const next = !showManual;
    setShowManual(next);
    if (next && selInst) {
      setEmuTarget((v) => v || selInst.name || "");
      setManualSerial((v) => v || selInst.serial || "");
      setManualType((v) => v || selInst.deviceType || "");
      setManualOs((v) => v || selInst.osVersion || "");
    }
  };
  const [devices, setDevices] = useState([]);
  const [device, setDevice] = useState("");
  const targetDevice = device || selInst && selInst.serial || "";
  const [busy, setBusy] = useState("");
  const lintMode = busy.startsWith("lint-") ? busy.slice(5) : "";
  const lintTitle = LINT_TITLES[lintMode] || "";
  const [logs, setLogs] = useState([]);
  const logBox = useRef(null);
  const pushLog = (kind, text) => {
    const line = `${(/* @__PURE__ */ new Date()).toLocaleTimeString()} ${text}`;
    setLogs((prev) => [...prev.slice(-200), { kind, text: line }]);
  };
  const clearLogs = () => setLogs([]);
  useEffect(() => {
    const box = logBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs]);
  const refresh = async () => {
    if (busy === "refresh") return;
    setBusy("refresh");
    try {
      const [toolchain, emu, dev] = await Promise.all([
        rpc("toolchain"),
        rpc("emu.list").catch((e) => ({ raw: `\u83B7\u53D6\u5931\u8D25:${e.message}` })),
        rpc("devices")
      ]);
      setTc(toolchain);
      setTcMsg("");
      setEmuRaw(emu.raw || "(\u7A7A)");
      const list = emu.instances || [];
      const selName = instanceSel || list[0]?.name || "";
      setInstances(list);
      setInstanceSel((prev) => prev || selName);
      setDevices(dev.devices || []);
      if (dev.devices && dev.devices.length) {
        setDevice(pickDevice(dev.devices, list.find((it) => it.name === selName)?.serial));
      }
      pushLog("info", "\u5DF2\u5237\u65B0:\u5DE5\u5177\u94FE\u5C31\u7EEA" + (toolchain.devecoCliJs ? "" : "(devecocli \u672A\u627E\u5230)"));
    } catch (error) {
      pushLog("err", `\u5237\u65B0\u5931\u8D25:${error.message}`);
      setTcMsg(error.message);
    } finally {
      setBusy("");
    }
  };
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    refresh();
  }, []);
  useEffect(() => {
    if (!busy.startsWith("lint-")) return void 0;
    const t0 = Date.now();
    setLintSec(0);
    const id = setInterval(() => setLintSec(Math.floor((Date.now() - t0) / 1e3)), 1e3);
    return () => clearInterval(id);
  }, [busy]);
  useEffect(() => {
    lsSet(lsSessionKey("project"), project);
    lsSet(lsSessionKey("scanRoot"), scanRoot);
    lsSet("instance", instanceSel);
    lsSet(lsModuleKey(project), moduleSel);
  }, [project, scanRoot, instanceSel, moduleSel]);
  useEffect(() => {
    if (!scopeCwd || scanRootEdited.current) return;
    setScanRoot((prev) => prev || scopeCwd);
  }, [scopeCwd]);
  useEffect(() => {
    setFixReady({ changed: false, all: false });
    setLintReady(false);
  }, [project]);
  useEffect(() => {
    if (project) loadProjectInfo(project);
  }, [project]);
  useEffect(() => {
    const el = shotBoxRef.current;
    if (!el || !shot) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      setShotView((v) => {
        const zoom = Math.min(4, Math.max(0.25, Math.round(v.zoom * (e.deltaY < 0 ? 1.1 : 0.9) * 100) / 100));
        const k = zoom / v.zoom;
        return { zoom, x: mx * (1 - k) + k * v.x, y: my * (1 - k) + k * v.y };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [shot]);
  const pickNative = async () => {
    setBusy("browse");
    try {
      const ui = ctx.get("uiWorkspace");
      if (ui && typeof ui.pickDirectory === "function") {
        const p = await ui.pickDirectory();
        if (!p) return;
        scanRootEdited.current = true;
        setScanRoot(p);
        pushLog("ok", `\u5DF2\u8BBE\u7F6E\u67E5\u627E\u76EE\u5F55:${p}`);
        const info = await loadProjectInfo(p);
        if (info && info.isProject) {
          setProject(p);
          setProjectOptions((prev) => prev.includes(p) ? prev : [p, ...prev]);
          pushLog("ok", `\u8BE5\u76EE\u5F55\u662F\u9E3F\u8499\u5DE5\u7A0B,\u5DF2\u9009\u4E2D\u9879\u76EE:${p}`);
        } else {
          await scanInto(p);
        }
      } else {
        pushLog("err", "\u7CFB\u7EDF\u76EE\u5F55\u9009\u62E9\u4E0D\u53EF\u7528,\u8BF7\u7528\u300C\u626B\u63CF\u300D\u6216\u76F4\u63A5\u7C98\u8D34\u8DEF\u5F84");
      }
    } catch (error) {
      pushLog("err", `\u7CFB\u7EDF\u9009\u62E9\u5931\u8D25:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy("");
    }
  };
  const scanInto = async (root) => {
    const value = await rpc("scan", { root });
    setProjectOptions(value.projects || []);
    if (value.projects && value.projects.length) {
      setProject(value.projects[0]);
      pushLog("info", `\u626B\u63CF\u300C${value.root}\u300D\u53D1\u73B0 ${value.projects.length} \u4E2A\u9879\u76EE,\u5DF2\u9ED8\u8BA4\u9009\u4E2D\u7B2C\u4E00\u4E2A`);
    } else {
      setModules([]);
      setModuleSel("");
      pushLog("info", `\u201C${value.root}\u201D\u4E0B(\u22643 \u5C42)\u672A\u53D1\u73B0\u9E3F\u8499\u9879\u76EE`);
    }
    return value.projects || [];
  };
  const runScan = async () => {
    const root = scanRoot.trim();
    if (!root) {
      pushLog("err", "\u8BF7\u5148\u586B\u5199\u626B\u63CF\u76EE\u5F55");
      return;
    }
    setBusy("scan");
    try {
      await scanInto(root);
    } catch (error) {
      pushLog("err", `\u626B\u63CF\u5931\u8D25:${error.message}`);
    } finally {
      setBusy("");
    }
  };
  const loadProjectInfo = async (proj) => {
    if (!proj) return null;
    try {
      const info = await rpc("project.info", { projectPath: proj });
      const mods = info.modules || [];
      setModules(mods);
      const remembered = lsGet(lsModuleKey(proj));
      setModuleSel(() => mods.includes(remembered) ? remembered : mods.includes("entry") ? "entry" : mods[0] || "");
      return info;
    } catch {
      return null;
    }
  };
  const runLint = async (mode) => {
    const p = project.trim();
    if (!p) {
      pushLog("err", "\u8BF7\u5148\u5728\u201C\u5E94\u7528\u9879\u76EE\u201D\u9009\u62E9\u9879\u76EE");
      return;
    }
    const title = LINT_TITLES[mode];
    const t0 = Date.now();
    setBusy(`lint-${mode}`);
    pushLog("info", `[\u4EE3\u7801\u68C0\u67E5] ${title}\u5F00\u59CB:${p}`);
    if (mode.startsWith("fix")) pushLog("info", "[\u4EE3\u7801\u68C0\u67E5] \u4FEE\u590D\u7ED3\u675F\u540E\u4F1A\u81EA\u52A8\u590D\u68C0\u4E00\u6B21,\u603B\u8017\u65F6\u7EA6\u4E3A\u5355\u6B21\u68C0\u67E5\u7684\u4E24\u500D");
    try {
      const v = await rpc("check.lint", { projectPath: p, mode });
      const st = v.summary || {};
      const line = v.stats || `\u9519\u8BEF ${st.errors ?? "-"}\u3001\u8B66\u544A ${st.warnings ?? "-"}\u3001\u5EFA\u8BAE ${st.suggestions ?? "-"}\u3001\u6D89\u53CA\u6587\u4EF6 ${st.files ?? "-"}`;
      pushLog(v.empty ? "info" : v.ok ? "ok" : "err", `[\u4EE3\u7801\u68C0\u67E5] ${title}\u5B8C\u6210 \u2014 ${line} \xB7 \u7528\u65F6 ${fmtDur(Date.now() - t0)}`);
      if (v.text && v.empty !== true) pushLog("raw", v.text);
      setLintReady(v.empty !== true);
      if (mode === "changed") setFixReady((r) => ({ ...r, changed: v.empty !== true }));
      if (mode === "all") setFixReady((r) => ({ ...r, all: true }));
    } catch (error) {
      pushLog("err", `[\u4EE3\u7801\u68C0\u67E5] ${title}\u5931\u8D25:${error.message}(\u7528\u65F6 ${fmtDur(Date.now() - t0)})`);
    } finally {
      setBusy("");
    }
  };
  const sendLint = async () => {
    if (!lintReady) {
      pushLog("err", "\u5C1A\u672A\u751F\u6210\u68C0\u67E5\u7ED3\u679C,\u8BF7\u5148\u6267\u884C\u4EE3\u7801\u68C0\u67E5");
      return;
    }
    setBusy("lint-send");
    try {
      await rpc("lint.notify", { sessionId: scope && scope.sessionId || "" });
      pushLog("ok", "\u68C0\u67E5\u7ED3\u679C\u5DF2\u5C31\u7EEA:\u53D1\u9001\u4E00\u6761\u6D88\u606F\u540E AI \u5373\u53EF\u8BFB\u53D6");
    } catch (error) {
      pushLog("err", `\u68C0\u67E5\u7ED3\u679C\u63D0\u4EA4\u5931\u8D25:${error.message}`);
    } finally {
      setBusy("");
    }
  };
  const pickDevice = (list, preferredSerial) => {
    if (!list || !list.length) return "";
    if (preferredSerial && list.includes(preferredSerial)) return preferredSerial;
    return list[0];
  };
  const pickInstance = async (name) => {
    setInstanceSel(name);
    try {
      const v = await rpc("emu.list");
      const list = v.instances || [];
      setInstances(list);
      const serial = list.find((it) => it.name === name)?.serial;
      if (serial) setDevice(serial);
      else pushLog("info", `${name} \u672A\u8FD0\u884C(\u5148\u70B9\u201C\u542F\u52A8\u201D),\u90E8\u7F72\u76EE\u6807\u4FDD\u6301 ${device || "\u65E0"}`);
    } catch (error) {
      pushLog("err", `\u540C\u6B65\u6A21\u62DF\u5668\u72B6\u6001\u5931\u8D25:${error.message}`);
    }
  };
  const pickDeviceTarget = (serial) => {
    setDevice(serial);
    const name = instances.find((it) => it.serial === serial)?.name;
    if (name) setInstanceSel(name);
  };
  const scanEmus = async () => {
    if (busy === "scan") return;
    setBusy("scan");
    try {
      const [v, dev] = await Promise.all([rpc("emu.list"), rpc("devices")]);
      const list = v.instances || [];
      setInstances(list);
      setEmuRaw(v.raw || "");
      const first = list[0];
      const selName = instanceSel || (first ? first.name : "");
      if (first) setInstanceSel((prev) => prev || first.name);
      else pushLog("info", "\u672A\u626B\u63CF\u5230\u53EF\u7528\u6A21\u62DF\u5668\u5B9E\u4F8B(\u53EF\u5728 DevEco Device Manager \u521B\u5EFA;\u82E5\u62A5\u6388\u6743\u8BF7\u5148\u5728\u7EC8\u7AEF\u6267\u884C devecocli emulator license accept)");
      const devList = dev.devices || [];
      setDevices(devList);
      const selSerial = list.find((it) => it.name === selName)?.serial;
      if (devList.length) setDevice(pickDevice(devList, selSerial));
    } catch (error) {
      pushLog("err", `\u626B\u63CF\u5931\u8D25:${error.message}`);
    } finally {
      setBusy("");
    }
  };
  const refreshInstAndDev = async () => {
    try {
      const [e, d] = await Promise.all([rpc("emu.list"), rpc("devices")]);
      setInstances(e.instances || []);
      setEmuRaw(e.raw || "");
      setDevices(d.devices || []);
    } catch {
    }
  };
  const emuStart = async () => {
    const target = instanceSel || emuTarget.trim();
    if (!target) {
      pushLog("err", "\u8BF7\u5148\u70B9\u201C\u626B\u63CF\u53EF\u7528\u201D\u5E76\u9009\u62E9\u5B9E\u4F8B,\u6216\u624B\u52A8\u8F93\u5165\u5B9E\u4F8B\u540D");
      return;
    }
    setBusy("start");
    const tick = setInterval(() => pushLog("info", "\u4ECD\u5728\u7B49\u5F85\u8BBE\u5907\u4E0A\u7EBF\u2026"), 15e3);
    try {
      const value = await rpc("emu.start", { name: target });
      pushLog(value.code === 0 ? "ok" : "err", `\u542F\u52A8\u6A21\u62DF\u5668[${target}] \u9000\u51FA\u7801=${value.code ?? "-"}
${value.output}`);
      if (value.code === 0) {
        if (value.ready && value.serial) {
          pushLog("ok", `\u8BBE\u5907\u5DF2\u5C31\u7EEA:${value.serial}`);
          setDevice(value.serial);
        } else {
          pushLog("info", "\u542F\u52A8\u547D\u4EE4\u5DF2\u8FD4\u56DE,\u4F46\u8BBE\u5907\u5C1A\u672A\u4E0A\u7EBF(\u53EF\u7A0D\u540E\u70B9\u201C\u68C0\u6D4B\u5C31\u7EEA\u201D)");
        }
        await refreshInstAndDev();
      }
    } catch (error) {
      pushLog("err", `\u542F\u52A8\u5931\u8D25:${error.message}`);
    } finally {
      clearInterval(tick);
      setBusy("");
    }
  };
  const emuStop = async () => {
    const target = instanceSel || emuTarget.trim();
    if (!target) {
      pushLog("err", "\u8BF7\u5148\u9009\u62E9\u5B9E\u4F8B\u6216\u8F93\u5165\u540D\u79F0/\u4E32\u53F7");
      return;
    }
    setBusy("stop");
    try {
      const value = await rpc("emu.stop", { target });
      pushLog(value.code === 0 ? "ok" : "err", `\u505C\u6B62\u6A21\u62DF\u5668[${target}] \u9000\u51FA\u7801=${value.code ?? "-"}
${value.output}`);
      if (value.code === 0) await refreshInstAndDev();
    } catch (error) {
      pushLog("err", `\u505C\u6B62\u5931\u8D25:${error.message}`);
    } finally {
      setBusy("");
    }
  };
  const deploy = async () => {
    if (!project.trim()) {
      pushLog("err", "\u8BF7\u5148\u5728\u201C\u5E94\u7528\u9879\u76EE\u201D\u9009\u62E9\u9879\u76EE");
      return;
    }
    if (!targetDevice) {
      pushLog("err", "\u8BF7\u5148\u5728\u201C\u90E8\u7F72\u76EE\u6807\u201D\u9009\u62E9\u5728\u7EBF\u8BBE\u5907");
      return;
    }
    setBusy("deploy");
    pushLog("info", `\u5F00\u59CB\u6784\u5EFA\u5E76\u90E8\u7F72 \u2192 ${project} @ ${targetDevice}(\u6784\u5EFA\u53EF\u80FD\u9700\u8981\u6570\u5206\u949F)`);
    try {
      const res = await fetch(`${API}/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath: project, device: targetDevice, module: modules.length > 1 ? moduleSel : void 0 })
      });
      if (res.status !== 200) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j && j.error && j.error.message) msg = j.error.message;
        } catch {
        }
        pushLog("err", `\u90E8\u7F72\u5931\u8D25:${msg}`);
        return;
      }
      if (!res.body) {
        pushLog("err", "\u5BBF\u4E3B\u672A\u8FD4\u56DE\u53EF\u8BFB\u5185\u5BB9");
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let exitCode = null;
      const flushLine = (line) => {
        if (!line) return;
        if (line.startsWith("[HMOS_EXIT]=")) {
          exitCode = Number(line.slice(12));
          return;
        }
        const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").replace(/\s+$/, "");
        if (clean.trim()) pushLog("raw", clean);
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) flushLine(l.replace(/\r$/, ""));
      }
      if (buf.trim()) flushLine(buf.replace(/\r/g, ""));
      pushLog(exitCode === 0 ? "ok" : "err", exitCode === 0 ? "\u90E8\u7F72\u5B8C\u6210" : `\u90E8\u7F72\u7ED3\u675F(\u9000\u51FA\u7801 ${exitCode ?? "\u672A\u77E5"})`);
    } catch (error) {
      pushLog("err", `\u90E8\u7F72\u5931\u8D25:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy("");
    }
  };
  const checkReady = async () => {
    const serial = selInst && selInst.serial || manualSerial.trim();
    if (!serial) {
      pushLog("err", "\u8BF7\u5148\u9009\u62E9\u6A21\u62DF\u5668\u5B9E\u4F8B\u6216\u586B\u5199\u4E32\u53F7");
      return;
    }
    setBusy("ready");
    try {
      const r = await rpc("device.ready", { serial });
      if (r.online) {
        pushLog("ok", `\u8BBE\u5907 ${serial} \u5DF2\u5C31\u7EEA`);
        setDevices(r.devices || []);
        setDevice(r.serial);
      } else pushLog("info", `\u8BBE\u5907 ${serial} \u5C1A\u672A\u4E0A\u7EBF,\u8BF7\u7A0D\u540E\u518D\u8BD5`);
    } catch (error) {
      pushLog("err", `\u5C31\u7EEA\u68C0\u6D4B\u5931\u8D25:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy("");
    }
  };
  const takeShot = async () => {
    if (!targetDevice) {
      pushLog("err", "\u8BF7\u5148\u9009\u62E9\u5728\u7EBF\u8BBE\u5907(\u90E8\u7F72\u76EE\u6807)");
      return;
    }
    setBusy("shot");
    try {
      const root = scope && scope.cwd || "";
      const v = await rpc("screenshot", { device: targetDevice, root, preview: true });
      if (v && v.path) {
        pushLog("ok", `\u622A\u56FE\u5DF2\u4FDD\u5B58 \u2192 ${v.path}`);
        setShot({ path: v.path, dataUrl: v.dataUrl || null });
        setShotView({ zoom: 1, x: 0, y: 0 });
      } else pushLog("info", "\u622A\u56FE\u5B8C\u6210,\u4F46\u5BBF\u4E3B\u672A\u8FD4\u56DE\u4FDD\u5B58\u8DEF\u5F84");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      pushLog("err", `\u622A\u56FE\u5931\u8D25:${msg}${/unknown method|非 JSON/.test(msg) ? "(\u5BBF\u4E3B\u7AEF\u5C1A\u672A\u52A0\u8F7D\u65B0 API,\u8BF7\u91CD\u542F dsh web \u540E\u91CD\u8BD5)" : ""}`);
    } finally {
      setBusy("");
    }
  };
  const installCli = async () => {
    if (busy === "cli") return;
    setBusy("cli");
    try {
      const v = await rpc("deveco.install");
      pushLog(v.code === 0 ? "ok" : "err", `${v.note}
${v.output}`);
      if (v.code === 0) {
        const t = await rpc("toolchain");
        setTc(t);
        pushLog("ok", "\u5DF2\u91CD\u65B0\u68C0\u6D4B\u5DE5\u5177\u94FE");
      }
    } catch (error) {
      pushLog("err", `\u5B89\u88C5\u5931\u8D25:${error.message}`);
    } finally {
      setBusy("");
    }
  };
  const shortPath = (p) => {
    const parts = String(p).split(/[\\/]/);
    return parts.length > 2 ? `\u2026\\${parts.slice(-2).join("\\")}` : String(p);
  };
  const onShotImgDragStart = (e) => {
    if (!shot) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = shotView;
    const move = (ev) => setShotView((v) => ({ zoom: v.zoom, x: base.x + (ev.clientX - startX), y: base.y + (ev.clientY - startY) }));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const onPanelDragStart = (e) => {
    if (e.target !== e.currentTarget) return;
    const el = e.currentTarget;
    const startY = e.clientY;
    const startTop = el.scrollTop;
    const move = (ev) => {
      el.scrollTop = startTop - (ev.clientY - startY);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const copyText = (text) => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    };
    try {
      navigator.clipboard.writeText(text).then(done).catch(() => pushLog("err", "\u590D\u5236\u5931\u8D25(\u6D4F\u89C8\u5668\u672A\u6388\u6743\u526A\u8D34\u677F)"));
    } catch {
      pushLog("err", "\u590D\u5236\u5931\u8D25(\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u526A\u8D34\u677F API)");
    }
  };
  const updateCli = async () => {
    if (busy === "cli-up") return;
    setBusy("cli-up");
    try {
      const v = await rpc("deveco.update");
      pushLog(v.code === 0 ? "ok" : "err", `${v.note}
${v.output}`);
      if (v.code === 0) {
        const t = await rpc("toolchain");
        setTc(t);
        pushLog("ok", "\u5DF2\u91CD\u65B0\u68C0\u6D4B\u5DE5\u5177\u94FE");
      }
    } catch (error) {
      pushLog("err", `\u66F4\u65B0\u5931\u8D25:${error.message}`);
    } finally {
      setBusy("");
    }
  };
  const nodes = [];
  nodes.push(h(
    "div",
    { key: "head", style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 } },
    h("span", { style: { width: 20, height: 20, display: "inline-flex", color: s.accent } }, h(Icon, { src: IC.emulator, size: 20 })),
    h(
      "div",
      { style: { flex: 1 } },
      h("div", { style: { fontSize: 14, fontWeight: 600 } }, "\u9E3F\u8499\u6A21\u62DF\u5668"),
      h("div", { style: { fontSize: 11, color: s.muted } }, "DevEco \u90E8\u7F72\u63A7\u5236\u53F0")
    ),
    h(Btn, { icon: IC.refresh, ghost: true, disabled: busy === "refresh", onClick: refresh, title: "\u5237\u65B0" }, "\u5237\u65B0")
  ));
  if (tc && tc.devecoCliJs) {
    nodes.push(h(
      "div",
      { key: "cliVer", style: { display: "flex", alignItems: "center", gap: 6, margin: "-4px 0 8px", fontSize: 11, color: s.faint } },
      h("span", null, `devecocli ${tc.devecoCliVersion || "\u7248\u672C\u672A\u77E5"}`),
      h(Btn, { ghost: true, disabled: busy !== "", onClick: updateCli, style: { padding: "2px 8px" } }, busy === "cli-up" ? "\u66F4\u65B0\u4E2D\u2026" : "\u66F4\u65B0")
    ));
  }
  if (tc) {
    if (!tc.devecoCliJs) nodes.push(h(
      "div",
      { key: "warnCli", style: warnBox },
      h("div", null, "\u672A\u68C0\u6D4B\u5230 devecocli:\u542F\u52A8/\u90E8\u7F72\u529F\u80FD\u4E0D\u53EF\u7528\u3002"),
      h("div", { style: { fontSize: 11, marginTop: 2, marginBottom: 6, opacity: 0.85 } }, "\u5EFA\u8BAE\u5B89\u88C5 @deveco/deveco-cli(\u4EC5\u8986\u76D6 CLI;hdc/\u6A21\u62DF\u5668\u4ECD\u9700\u5B89\u88C5 DevEco Studio SDK \u5E76\u8BBE\u7F6E DEVECO_SDK_HOME)\u3002"),
      h(Btn, { secondary: true, disabled: busy === "cli", onClick: installCli }, busy === "cli" ? "\u5B89\u88C5\u4E2D\u2026" : "\u4E00\u952E\u5B89\u88C5 devecocli")
    ));
    if (!tc.hdcExe) nodes.push(h("div", { key: "warnHdc", style: warnBox }, "\u672A\u68C0\u6D4B\u5230 hdc:\u8BF7\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF DEVECO_SDK_HOME(\u6307\u5411 DevEco Studio SDK \u76EE\u5F55)\u540E\u91CD\u542F dsh web\u3002"));
  }
  nodes.push(h(
    Card,
    { key: "emuCard", title: "\u6A21\u62DF\u5668\u5B9E\u4F8B" },
    h(
      "div",
      { style: row },
      h("span", { style: label }, "\u6A21\u62DF\u5668"),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 } },
        h(Dropdown, {
          value: instanceSel,
          placeholder: instances.length ? "\u9009\u62E9\u6A21\u62DF\u5668\u5B9E\u4F8B\u2026" : "(\u5148\u70B9\u201C\u626B\u63CF\u53EF\u7528\u201D)",
          options: instances.map((it) => ({ value: it.name, label: it.name, status: it.status })),
          onChange: pickInstance
        }),
        h(Btn, { icon: IC.scan, secondary: true, disabled: busy !== "", onClick: scanEmus }, busy === "scan" ? "\u626B\u63CF\u4E2D" : "\u626B\u63CF\u53EF\u7528")
      ),
      h(Btn, { icon: IC.play, primary: true, disabled: busy !== "" || !instanceSel && !emuTarget.trim(), onClick: emuStart }, busy === "start" ? "\u542F\u52A8\u4E2D" : "\u542F\u52A8"),
      h(Btn, { icon: IC.stop, dangerSolid: true, disabled: busy !== "", onClick: emuStop }, "\u505C\u6B62")
    ),
    h(
      "div",
      { style: row },
      h("span", { style: label }, "\u72B6\u6001"),
      selInst ? h(
        "span",
        { style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: selInst.status === "running" ? s.ok : s.danger } },
        h("span", { style: { width: 8, height: 8, borderRadius: "50%", background: selInst.status === "running" ? s.ok : s.danger } }),
        selInst.status === "running" ? "\u8FD0\u884C\u4E2D" : "\u5DF2\u505C\u6B62"
      ) : h("span", { style: { fontSize: 11, color: s.faint } }, "\u672A\u5B9E\u4F8B"),
      h("div", { style: { flex: 1 } }),
      h(Btn, { secondary: true, disabled: busy !== "", onClick: checkReady, title: "\u68C0\u6D4B\u6A21\u62DF\u5668\u4E32\u53F7\u662F\u5426\u5DF2\u4E0A\u7EBF" }, "\u68C0\u6D4B\u5C31\u7EEA"),
      h(Btn, { ghost: true, disabled: busy !== "", onClick: toggleManual }, showManual ? "\u6536\u8D77\u624B\u52A8\u8F93\u5165" : "\u624B\u52A8\u8F93\u5165"),
      h(Btn, { ghost: true, disabled: busy !== "", onClick: () => setShowRaw((v) => !v) }, showRaw ? "\u6536\u8D77\u539F\u59CB\u8F93\u51FA" : "\u539F\u59CB\u8F93\u51FA")
    ),
    showManual ? h(
      "div",
      { key: "manual", style: { marginTop: 4 } },
      h(
        "div",
        { style: { ...row, marginBottom: 6 } },
        h("span", { style: { width: 56, fontSize: 12, color: s.muted } }, "\u5B9E\u4F8B\u540D"),
        h("input", { style: field, value: emuTarget, placeholder: "\u5982 Pura 90", onChange: (e) => setEmuTarget(e.target.value), spellCheck: false })
      ),
      h(
        "div",
        { style: { ...row, marginBottom: 6 } },
        h("span", { style: { width: 56, fontSize: 12, color: s.muted } }, "\u4E32\u53F7"),
        h("input", { style: field, value: manualSerial, placeholder: "\u5982 127.0.0.1:5555", onChange: (e) => setManualSerial(e.target.value), spellCheck: false })
      ),
      h(
        "div",
        { style: { ...row, marginBottom: 6 } },
        h("span", { style: { width: 56, fontSize: 12, color: s.muted } }, "\u8BBE\u5907\u7C7B\u578B"),
        h("input", { style: field, value: manualType, placeholder: "\u5982 phone", onChange: (e) => setManualType(e.target.value), spellCheck: false })
      ),
      h(
        "div",
        { style: { ...row, marginBottom: 6 } },
        h("span", { style: { width: 56, fontSize: 12, color: s.muted } }, "\u7CFB\u7EDF\u7248\u672C"),
        h("input", { style: field, value: manualOs, placeholder: "\u5982 HarmonyOS 6.1.1(24)", onChange: (e) => setManualOs(e.target.value), spellCheck: false })
      ),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 4 } },
        h(Btn, { secondary: true, disabled: !manualSerial.trim(), onClick: () => setDevice(manualSerial.trim()) }, "\u7528\u8BE5\u4E32\u53F7\u4F5C\u4E3A\u90E8\u7F72\u8BBE\u5907"),
        h("div", { style: { fontSize: 11, color: s.faint } }, "\u5B9E\u4F8B\u540D\u53C2\u4E0E\u542F\u52A8/\u505C\u6B62;\u4E32\u53F7\u53EF\u4E00\u952E\u8BBE\u4E3A\u90E8\u7F72\u8BBE\u5907")
      )
    ) : null,
    showRaw && emuRaw ? h("pre", { style: { ...field, maxHeight: 110, overflow: "auto", margin: "2px 0 0", fontSize: 10, whiteSpace: "pre-wrap" } }, emuRaw) : null
  ));
  nodes.push(h(
    Card,
    { key: "projCard", title: "\u5E94\u7528\u9879\u76EE" },
    h(
      "div",
      { style: row },
      h("span", { style: label }, "\u67E5\u627E\u76EE\u5F55"),
      h("input", {
        style: field,
        value: scanRoot,
        placeholder: "\u9ED8\u8BA4\u4E3A\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55",
        onChange: (e) => {
          scanRootEdited.current = true;
          setScanRoot(e.target.value);
        },
        spellCheck: false
      }),
      h(Btn, { icon: IC.folder, secondary: true, disabled: busy !== "", onClick: pickNative }, "\u6D4F\u89C8")
    ),
    h(
      "div",
      { style: row },
      h("span", { style: label }, "\u9879\u76EE"),
      h(Dropdown, {
        value: project,
        placeholder: projectOptions.length ? "\u9009\u62E9\u626B\u63CF\u5230\u7684\u9879\u76EE\u2026" : "\u626B\u63CF\u540E\u9009\u62E9\u9879\u76EE",
        options: projectOptions.map((p) => ({ value: p, label: p })),
        onChange: setProject
      }),
      h(Btn, { icon: IC.scan, secondary: true, disabled: busy !== "", onClick: runScan }, busy === "scan" ? "\u626B\u63CF\u4E2D" : "\u626B\u63CF")
    ),
    modules.length > 1 ? h(
      "div",
      { style: row, key: "moduleRow" },
      h("span", { style: label }, "\u5165\u53E3\u6A21\u5757"),
      h(Dropdown, { value: moduleSel, placeholder: "\u9009\u62E9\u5165\u53E3\u6A21\u5757", options: modules.map((m) => ({ value: m, label: m })), onChange: setModuleSel })
    ) : null,
    // On-demand project checks (no model-tool schema cost). Details live in tooltips so
    // the panel itself stays free of explanatory clutter.
    h(
      "div",
      { style: row, key: "lintRow" },
      h("span", { style: label }, "\u4EE3\u7801\u68C0\u67E5"),
      h(Btn, {
        secondary: true,
        disabled: busy !== "" || !project.trim(),
        onClick: () => runLint("changed"),
        title: "\u53EA\u68C0\u67E5\u5DF2\u8DDF\u8E2A\u6587\u4EF6\u7684\u672A\u63D0\u4EA4\u6539\u52A8(\u5FEB;\u65B0\u5EFA\u6587\u4EF6\u8BF7\u7528\u300C\u5168\u91CF\u68C0\u67E5\u300D)"
      }, busy === "lint-changed" ? "\u68C0\u67E5\u4E2D\u2026" : "\u68C0\u67E5\u6539\u52A8"),
      h(Btn, {
        secondary: true,
        disabled: busy !== "" || !project.trim(),
        onClick: () => runLint("all"),
        title: "\u68C0\u67E5\u6574\u4E2A\u9879\u76EE(\u8F83\u6162)"
      }, busy === "lint-all" ? "\u68C0\u67E5\u4E2D\u2026" : "\u5168\u91CF\u68C0\u67E5"),
      h(Btn, {
        secondary: true,
        disabled: busy !== "" || !lintReady,
        onClick: sendLint,
        title: "\u5C06\u6700\u8FD1\u4E00\u6B21\u68C0\u67E5\u7ED3\u679C\u63D0\u4F9B\u7ED9 AI(\u53D1\u9001\u6D88\u606F\u540E\u751F\u6548)"
      }, busy === "lint-send" ? "\u53D1\u9001\u4E2D\u2026" : "\u53D1\u9001\u5230\u5BF9\u8BDD")
    ),
    // Fixing writes to the source files, so each button unlocks only after the check with the
    // same scope has run: you see what is in range before anything is rewritten.
    h(
      "div",
      { style: row, key: "fixRow" },
      h("span", { style: label }, "\u4EE3\u7801\u4FEE\u590D"),
      h(Btn, {
        secondary: true,
        disabled: busy !== "" || !fixReady.changed,
        onClick: () => runLint("fix"),
        title: fixReady.changed ? "\u81EA\u52A8\u4FEE\u590D\u672A\u63D0\u4EA4\u6539\u52A8\u4E2D\u53EF\u4FEE\u590D\u7684\u544A\u8B66;\u65E0\u6CD5\u81EA\u52A8\u4FEE\u590D\u7684\u4E0D\u4F1A\u5217\u51FA" : "\u5148\u70B9\u300C\u68C0\u67E5\u6539\u52A8\u300D\u67E5\u770B\u8303\u56F4\u540E\u624D\u80FD\u4FEE\u590D"
      }, busy === "lint-fix" ? "\u4FEE\u590D\u4E2D\u2026" : "\u81EA\u52A8\u4FEE\u590D"),
      h(Btn, {
        secondary: true,
        disabled: busy !== "" || !fixReady.all,
        onClick: () => runLint("fix-all"),
        title: fixReady.all ? "\u81EA\u52A8\u4FEE\u590D\u6574\u4E2A\u9879\u76EE\u4E2D\u53EF\u4FEE\u590D\u7684\u544A\u8B66;\u65E0\u6CD5\u81EA\u52A8\u4FEE\u590D\u7684\u4E0D\u4F1A\u5217\u51FA" : "\u5148\u70B9\u300C\u5168\u91CF\u68C0\u67E5\u300D\u67E5\u770B\u8303\u56F4\u540E\u624D\u80FD\u4FEE\u590D"
      }, busy === "lint-fix-all" ? "\u4FEE\u590D\u4E2D\u2026" : "\u5168\u91CF\u4FEE\u590D")
    ),
    // Live status while a check runs: the linter only writes its report at the end, so the
    // ticking clock is what tells the user it is still working.
    lintTitle ? h(
      "div",
      {
        key: "lintProgress",
        style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: s.muted, margin: "-2px 0 8px" }
      },
      h("span", { style: { display: "inline-flex" } }, h(Icon, { src: IC.clock, size: 12 })),
      `${lintTitle}\u8FDB\u884C\u4E2D\u2026 \u5DF2\u7528\u65F6 ${lintSec}s(\u68C0\u67E5\u5DE5\u5177\u5728\u7ED3\u675F\u65F6\u624D\u8F93\u51FA\u62A5\u544A)`
    ) : null,
    h("div", { style: { fontSize: 11, color: s.faint, margin: "-2px 0 8px" } }, "\u9700\u5305\u542B build-profile.json5 \u7684\u9879\u76EE\u6839;\u70B9\u300C\u626B\u63CF\u300D\u5217\u51FA\u5B50\u76EE\u5F55\u9879\u76EE,\u6216\u300C\u6D4F\u89C8\u300D\u76F4\u63A5\u9009\u62E9")
  ));
  const devLabel = (serial) => {
    const n = instances.find((it) => it.serial === serial)?.name;
    return n ? `${n} (${serial})` : serial;
  };
  nodes.push(h(
    Card,
    { key: "devCard", title: "\u90E8\u7F72\u76EE\u6807" },
    h(
      "div",
      { style: row },
      h("span", { style: label }, "\u8BBE\u5907"),
      devices.length > 1 ? h(Dropdown, {
        value: targetDevice,
        placeholder: "\u9009\u62E9\u5728\u7EBF\u8BBE\u5907\u2026",
        options: devices.map((d) => ({ value: d, label: devLabel(d) })),
        onChange: pickDeviceTarget
      }) : h(
        "div",
        { style: { ...field, display: "flex", alignItems: "center", color: targetDevice ? s.fg : s.faint, cursor: "default" } },
        targetDevice ? devLabel(targetDevice) : "\u6682\u65E0\u5728\u7EBF\u8BBE\u5907"
      )
    ),
    // The screenshot action sits under the device row, matches the field height, and stays
    // outlined so it never competes with the primary deploy button.
    h(
      "div",
      { style: { marginTop: 8 } },
      h(Btn, {
        secondary: true,
        icon: IC.camera,
        disabled: busy !== "" || !targetDevice,
        onClick: takeShot,
        style: { width: "100%" },
        title: "\u7528 devecocli \u622A\u53D6\u8BBE\u5907\u5C4F\u5E55,PNG \u4FDD\u5B58\u5230 <\u5DE5\u4F5C\u533A>/screenshots"
      }, busy === "shot" ? "\u622A\u56FE\u4E2D\u2026" : "\u622A\u56FE\u5F53\u524D\u8BBE\u5907\u5C4F\u5E55")
    ),
    targetDevice ? h("div", { style: { fontSize: 11, color: s.faint, marginTop: 6 } }, "\u90E8\u7F72\u5C06\u53D1\u9001\u5230\u8BE5\u8BBE\u5907(\u542F\u52A8\u6A21\u62DF\u5668\u540E\u81EA\u52A8\u66F4\u65B0)") : devices.length ? h("div", { style: { fontSize: 11, color: s.faint, marginTop: 6 } }, `\u68C0\u6D4B\u5230 ${devices.length} \u53F0\u5728\u7EBF\u8BBE\u5907,\u5DF2\u9ED8\u8BA4\u9009\u7B2C\u4E00\u53F0`) : h("div", { style: { fontSize: 11, color: s.faint, marginTop: 6 } }, "\u6682\u65E0\u5728\u7EBF\u8BBE\u5907;\u8BF7\u5148\u5728\u300C\u6A21\u62DF\u5668\u5B9E\u4F8B\u300D\u542F\u52A8\u6A21\u62DF\u5668")
  ));
  nodes.push(h(
    "div",
    { key: "deployBtn", style: { marginTop: 2 } },
    h(Btn, {
      primary: true,
      disabled: busy !== "",
      onClick: deploy,
      icon: IC.deploy,
      style: { width: "100%", padding: "10px 12px", fontWeight: 600, fontSize: 13 }
    }, busy === "deploy" ? "\u6784\u5EFA\u5E76\u90E8\u7F72\u4E2D\u2026" : "\u6784\u5EFA\u5E76\u90E8\u7F72\u5230\u6240\u9009\u8BBE\u5907"),
    h("div", { style: { fontSize: 11, color: s.faint, margin: "6px 2px 0" } }, "devecocli run:\u6784\u5EFA \u2192 \u5B89\u88C5 \u2192 \u542F\u52A8(\u9996\u6B21\u7EA6 1\u20133 \u5206\u949F)")
  ));
  nodes.push(h(
    "div",
    { key: "logWrap", style: { ...card, marginTop: 4, padding: 8, marginBottom: 0 } },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 } },
      h("span", { style: { fontSize: 11, color: s.muted, letterSpacing: ".06em", textTransform: "uppercase" } }, "\u8C03\u8BD5\u8F93\u51FA"),
      h("div", { style: { flex: 1 } }),
      h(Btn, { ghost: true, onClick: clearLogs, style: { padding: "2px 8px" } }, "\u6E05\u7A7A")
    ),
    h("pre", {
      key: "logbox",
      ref: logBox,
      style: {
        ...field,
        maxHeight: 220,
        overflow: "auto",
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
        fontSize: 11
      }
    }, logs.length === 0 ? "(\u6784\u5EFA/\u90E8\u7F72\u4FE1\u606F\u5C06\u663E\u793A\u5728\u8FD9\u91CC)" : logs.map((l, i) => h("div", { key: i, style: { ...logLine(l.kind), color: l.kind === "err" ? s.danger : l.kind === "ok" ? s.ok : l.kind === "info" ? s.muted : s.fg } }, l.text)))
  ));
  if (tcMsg) nodes.push(h("div", { key: "tcerr", style: { color: s.danger, fontSize: 12, marginTop: 6 } }, tcMsg));
  if (shot) nodes.push(h(
    Card,
    {
      key: "shotCard",
      title: "\u6700\u8FD1\u622A\u56FE",
      style: { marginTop: 12 },
      action: h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6 } },
        h("span", { style: { fontSize: 10, color: s.faint } }, `${Math.round(shotView.zoom * 100)}%`),
        h(Btn, { ghost: true, style: { padding: "0 6px", fontSize: 14, lineHeight: 1 }, onClick: () => setShot(null), title: "\u5173\u95ED" }, "\xD7")
      )
    },
    h(
      "div",
      {
        ref: shotBoxRef,
        style: {
          background: "#15171d",
          border: `1px solid ${s.border}`,
          borderRadius: 8,
          height: 300,
          overflow: "hidden",
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }
      },
      shot.dataUrl ? h("img", {
        src: shot.dataUrl,
        draggable: false,
        onMouseDown: onShotImgDragStart,
        onDoubleClick: () => setShotView({ zoom: 1, x: 0, y: 0 }),
        style: {
          maxWidth: "100%",
          maxHeight: "100%",
          borderRadius: 6,
          userSelect: "none",
          cursor: "grab",
          transform: `translate(${shotView.x}px, ${shotView.y}px) scale(${shotView.zoom})`,
          transformOrigin: "center center"
        }
      }) : h("div", { style: { fontSize: 11, color: s.faint, padding: "18px 0" } }, "(\u9884\u89C8\u4E0D\u53EF\u7528,\u6587\u4EF6\u5DF2\u4FDD\u5B58)")
    ),
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 8 } },
      h("span", {
        title: shot.path,
        style: { flex: 1, minWidth: 0, fontSize: 10, color: s.faint, fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
      }, shortPath(shot.path)),
      h(Btn, {
        secondary: true,
        style: { padding: "4px 10px", color: copied ? s.ok : s.fg, border: `1px solid ${copied ? s.ok : s.border}` },
        onClick: () => copyText(shot.path)
      }, copied ? "\u5DF2\u590D\u5236 \u2713" : "\u590D\u5236\u8DEF\u5F84")
    ),
    shot.dataUrl ? h("div", { style: { fontSize: 10, color: s.faint, marginTop: 6 } }, "\u6EDA\u8F6E\u7F29\u653E \xB7 \u6309\u4F4F\u62D6\u52A8\u5E73\u79FB \xB7 \u53CC\u51FB\u91CD\u7F6E") : null
  ));
  return h("div", {
    onMouseDown: onPanelDragStart,
    style: {
      padding: 8,
      color: s.fg,
      height: "100%",
      overflowY: "auto",
      boxSizing: "border-box",
      background: "var(--dsw-alias-bg-base, rgba(46, 52, 66, 0.55))",
      backdropFilter: "blur(18px) saturate(1.15)",
      WebkitBackdropFilter: "blur(18px) saturate(1.15)"
    }
  }, nodes);
}
function apply(ctx) {
  let disposed = false;
  let registered = false;
  let timer = null;
  let attempts = 0;
  const tryRegister = () => {
    if (disposed || registered) return;
    try {
      const better = ctx.get("betterSidebar");
      if (better === void 0 || typeof better.registerTab !== "function") {
        if (++attempts > 80) {
          console.warn("[dsh-hmos-emulator] \u672A\u68C0\u6D4B\u5230 dsh-better-sidebar \u670D\u52A1,\u505C\u6B62\u7B49\u5F85\u3002");
          return;
        }
        timer = setTimeout(tryRegister, 700);
        return;
      }
      registered = true;
      ctx.effect(() => better.registerTab({
        id: "hmos:emulator",
        title: () => "\u9E3F\u8499\u6A21\u62DF\u5668",
        icon: (size) => h(Icon, { src: IC.emulator, size: size || 16 }),
        order: 55,
        single: true,
        component: (props) => h(Panel, { scope: props.scope, ctx })
      }), "dsh-hmos-emulator: register tab");
    } catch (error) {
      console.error("[dsh-hmos-emulator] \u5BA2\u6237\u7AEF\u6CE8\u518C\u5F02\u5E38(\u5DF2\u9694\u79BB,\u4E0D\u5F71\u54CD DSH):", error);
    }
  };
  tryRegister();
  ctx.effect(() => () => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
}
module.exports = { apply };
return module.exports; } });
