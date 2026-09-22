/** Minimal cordis context: only the members used here, avoiding the full DSH type graph. */
export interface Ctx {
    get(name: string): any;
    effect(callback: () => any, label?: string): void;
}
export declare const name = "dsh-hmos-emulator";
/**
 * The JS entry a devecocli path stands for. `npm i -g` writes `devecocli.cmd` / `.ps1` / an
 * extension-less sh shim side by side in the global bin dir, and each is only a launcher whose last
 * line runs `<its dir>/node_modules/@deveco/deveco-cli/dist/cli.js`. Node cannot spawn such a
 * wrapper — a `.cmd` needs a shell, and going through cmd.exe would re-quote the Chinese labels and
 * regexes this plugin passes — so a wrapper is traced to its target and never executed.
 */
export declare function cliFromWrapper(candidate: string): string | undefined;
/** What the toolchain report should say about `DSH_HMOS_DEVECO_CLI`; '' when there is nothing to say. */
export declare function devecoCliHint(): string;
/**
 * Whether one request may reach this plugin's API — the browser-trust fence DSH applies to its
 * own /api (packages/client/connection/src/api-request-trust.ts). This route is registered as a
 * prefix on webServer, so it inherits none of DSH's fencing; without it a DNS-rebound host or a
 * malicious page could drive deveco.install, check.lint --fix or deploy on the host.
 *  - Host binds every request: a browser fills Host from the URL it believes it is talking to,
 *    so a rebound page carries the attacker's domain even though the socket lands here.
 *  - `sec-fetch-site: cross-site` is refused outright, whatever the Origin says.
 *  - An attached Origin must be this exact authority; "null" (opaque origin) is refused.
 * @param req - the node request.
 * @param trustedHosts - non-loopback authorities this deployment also serves, in DSH's
 *   client-connection shape: a port-less entry matches that host on any port.
 */
export declare function trustRequest(req: any, trustedHosts?: readonly string[]): boolean;
/**
 * Fence authorities for this deployment, taken from the same source DSH's own /api uses: the Web
 * runtime publishes `{ lanAddresses, trustedHosts }` as the `webRuntime` service, already folding
 * in `dsh web --trusted-host` and this machine's LAN literals (resolveLanTrust). Reading it keeps
 * the two fences in step — a second, plugin-private trust list is how a deployment ends up with a
 * panel that 403s while the rest of the GUI keeps working.
 * Loopback is always accepted by trustRequest and needs no entry here. When the service is absent
 * (a non-web host context), fall back to deriving the LAN literals a `0.0.0.0` bind is reached by:
 * only IP literals, since DNS rebinding needs an attacker-controlled name and an IP-literal Host
 * is safe on any port.
 * @param webRuntime - the published `{ lanAddresses, trustedHosts }`, when present.
 * @param bindHost - the webserver's active bind host.
 */
export declare function fenceAuthorities(webRuntime: any, bindHost: unknown): string[];
/**
 * Store a captured PNG through the harness attachment service so it can ride the same call as an
 * image block. Every failure (no attachment service, an image the deployment refuses) degrades to
 * the text-only answer: a picture is an optimization here, never the result of the call.
 */
export declare function attachmentRefForImage(ctx: any, filePath: any): Promise<{
    name?: any;
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
}>;
export interface LintSummary {
    issues: number;
    errors: number;
    warnings: number;
    suggestions: number;
    files: number;
}
/**
 * Uncommitted code files `--incremental` is expected to inspect, project-relative. Only tracked
 * modifications count: a new untracked .ets file is ignored by codelinter even
 * though it matches code-linter.json5 (so the docs' "new files" does not cover untracked ones).
 * Null when git cannot answer (not a repo, no git), which is the signal to run the full check
 * instead of silently under-checking.
 *
 * Paths come back relative to the REPOSITORY root while the caller works relative to the project,
 * so they are rebased; `core.quotepath=false` keeps a non-ASCII file name readable.
 *
 * Note: codelinter's "Files checked" counts files that produced a finding, not files scanned, so
 * it can never be used to tell "nothing to check" from "checked and clean" — this list is.
 */
export declare function changedCodeFiles(project: string): Promise<string[] | null>;
/**
 * The new-but-unadded code files of a working tree. `--incremental` never inspects them — codelinter
 * works from the tracked change set — so a refactor that *adds* files reads as a clean run
 *. Reporting them is what turns "pretending to be clean" into "saying what was not looked
 * at"; the lint behaviour itself is unchanged.
 */
export declare function untrackedCodeFiles(project: string): Promise<string[] | null>;
/**
 * How a requested lint scope resolves. `changed` needs a usable change set: without one the
 * incremental run can inspect nothing and still print a clean summary, so it escalates to the full
 * check — slower, but it cannot silently miss the file the caller just edited.
 */
export declare function lintScope(requested: string, changed: string[] | null): {
    full: boolean;
    escalated: boolean;
    checkedFiles: string[] | null;
};
/**
 * Read a code-check result the way a user would. "changed"/"fix" pass --incremental, which only
 * inspects uncommitted tracked files: with none of them the check covered nothing, and reporting that
 * as "0 errors" would be a false all-clear.
 */
export declare function lintOutcome(summary: LintSummary | null, mode: string, changedFiles: number | null): {
    empty: boolean;
    stats: string;
};
/** How much a fix run rewrote, which is the only result its own output can be trusted for. */
export declare function fixStats(fixedFiles: number | null): string;
/**
 * Cap a rendered tree by LINE count, never by characters: a character cap slices a line in half and
 * leaves a fragment that reads like a node. The note names `depth` and `filter`, both real emu_ui
 * parameters.
 */
export declare function capLines(lines: string[], max?: number): string[];
/**
 * One compact layout line: `Type [x1,y1,x2,y2] "text" [clickable] [scrollable] …`.
 * In practice: devecocli prints no node id in any mode (`--mode full` and
 * `--format json` included), so `emu_ui` assigns ids by position in the dump it just returned.
 */
export interface LayoutLine {
    /** Leading widget type; empty for the bare root bounds line. */
    type: string;
    /** Unescaped node text; empty for nodes that carry none. */
    text: string;
    /** Node rectangle, or null when the line carries no bounds. */
    bounds: [number, number, number, number] | null;
    /** Node rectangle area in px, used to prefer the innermost match. */
    area: number;
    clickable: boolean;
    /** Leading-space count; the dump nests children two spaces deeper than their parent. */
    indent: number;
    raw: string;
}
export declare function parseLayoutLine(raw: string): LayoutLine;
/** One tappable candidate for a label: the matched text node and the control actually pressed. */
export interface LabelMatch {
    /** Id (dump position) of the node whose text matched. */
    id: number;
    line: LayoutLine;
    /** The node whose center is pressed; its own id is what a later `click {id}` would use. */
    target: LayoutLine;
    targetIndex: number;
    /** Whether the match was the whole node text rather than a substring of it. */
    exact: boolean;
}
/**
 * Every distinct control a label can mean, best first.
 * Rank rather than take the first `includes` hit: a tap meant for a short label must not land on a
 * container whose text merely contains it. Exact text before mere containment, clickable nodes
 * before inert ones, then the smallest area so an inner node
 * wins over the outer container that holds it. Hits sharing one tap target (a label and the
 * container it climbed to) collapse into a single candidate, so the count is a control count.
 */
export declare function labelMatches(lines: LayoutLine[], label: string): LabelMatch[];
/**
 * Multiset difference of two rendered trees: the lines that disappeared, then the lines that
 * appeared. This exists for the shape `0 / 3` → `1 / 3`, where the whole tree is noise and the one
 * changed line is the assertion; `changed:0` is the "nothing moved" answer the caller checks for.
 */
export declare function diffLines(before: string[], after: string[]): string;
/**
 * Human-readable name of a node: its own text, or — for a container matched through a child's
 * label (the clickable tab that owns the text) — the first text inside it. Why:
 * `filter{clickableOnly}` reports the clickable Column, which carries no text of its own.
 */
export declare function nodeLabel(lines: LayoutLine[], index: number): string;
/**
 * Text breadcrumb of a node, outermost first, capped at `limit` entries — the identity of what is
 * about to be pressed. `nodeLabel` alone cannot answer this: the three cards each end in a
 * "Start" button, and only the card title tells them apart, so each ancestor contributes its
 * own label (own text, else the first text inside it — which for a card container IS its title).
 * Empty levels are skipped and repeats collapsed, so the tail is normally the pressed control.
 */
export declare function ancestorLabels(lines: LayoutLine[], index: number, limit?: number): string[];
/**
 * Text that identifies the page currently showing, used to answer "which page am I on" after a
 * tap. Prefers the shallowest text inside a `NavDestination` subtree (the page's own header), then
 * accepts the dump's first text only when it sits at the very top and is not a bare number —
 * shape of that failure: a page whose title area holds no words produced `"0"`, a stat
 * number, which names nothing. Returns '' rather than a guess, since callers confirm navigation
 * with it.
 */
export declare function pageTitle(lines: LayoutLine[]): string;
/** Flat JSON view. Cheaper than devecocli's nested `--format json` and it carries our ids. */
export declare function layoutJson(rows: {
    index: number;
    line: LayoutLine;
}[], lines?: LayoutLine[]): any[];
/** One codelinter finding, from the report table. */
export interface LintFinding {
    file: string;
    line: number;
    column: number;
    severity: string;
    rule: string;
    message: string;
}
/**
 * Parse codelinter's report table. Shape of a full run: rows are space-padded
 * (`No  File  Line  Column  Severity  Rule  Message`) and the File column is relative to the
 * process cwd — so the check must be run with `cwd: project` for project-relative paths.
 * The Message column is last, so any spacing inside it survives.
 */
export declare function parseLintTable(text: string): {
    findings: LintFinding[];
    summary: LintSummary | null;
};
/** One ArkTS compiler error from a failed build. */
export interface BuildError {
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
}
/**
 * Parse the ArkTS error blocks hvigor prints on a failed build. Shape of a failure:
 *   1 ERROR: 10505001 ArkTS Compiler Error
 *   Error Message: Expression expected. At File: C:/…/PanelBody.ets:185:34
 *   COMPILE RESULT:FAIL {ERROR:2 WARN:27}
 * The rollup variant spells its tail "At file:" lower-case on the next line, hence the tolerant
 * tail; the severity counts come from the COMPILE RESULT line when it is present.
 */
export declare function parseBuildErrors(text: string): {
    errors: BuildError[];
    errorCount: number;
    warnCount: number;
};
/**
 * Furthest deploy stage the output reached, from the stage markers `devecocli run` prints:
 *   `[hvigor build] Running...`      → `Build completed successfully.`
 *   `Installing artifacts to device` → `App installed successfully`
 *   `Launching <bundle>/<ability>...` → `start ability successfully.`
 * A failed run stops at the stage that failed, so the last marker seen is that stage.
 */
export declare function deployPhase(text: string): 'build' | 'install' | 'launch';
/** One hilog line, split into the fields a developer filters by. */
export interface LogLine {
    time: string;
    level: string;
    tag: string;
    message: string;
}
/**
 * Parse hilog lines. Line format:
 *   `09-13 21:49:14.737 10388 10388 W C02c02/PARAM: SystemReadParam failed!…`
 * `tag` is the part after the domain slash (`PARAM`), which is the name callers know.
 * Lines that do not match (devecocli's progress line, wrapped continuations) are dropped.
 */
export declare function parseLogLines(text: string): LogLine[];
/**
 * One line describing a step result. A batch answers with summaries plus the last step in full:
 * the point of `steps` is fewer round trips, so a step-by-step copy of every payload would undo it.
 */
export declare function stepSummary(action: string, value: any): string;
/**
 * The session workspace: the calling agent's session cwd, read off the tool-call context
 * (`exec.agent.session.header.cwd` — the durable absolute cwd the host recorded for the session).
 * Agentless calls (tests, bare dispatch) fall back to `process.cwd()`. This is where screenshots
 * belong: a path outside it is a path the agent cannot read back.
 */
export declare function sessionWorkspace(exec: any): string;
/** Prefix of every screenshot this plugin writes on its own initiative. */
export declare const AUTO_SHOT_PREFIX = "auto-";
/**
 * Prefix of the captures the **model tools** write on their own initiative (`emu_ui screenshot`).
 * They are named apart from `hmos-shot-*` for one reason: only a file the plugin knows it created
 * may ever be pruned. The user's own shots go through the panel and keep the `hmos-shot-*` name, so
 * "never auto-delete a hand-taken shot" is enforced by the name, not by a heuristic.
 */
export declare const TOOL_SHOT_PREFIX = "tool-";
/**
 * How many captures of one owned prefix are kept — both pruned prefixes share this number.
 *
 * A capture is a full-screen PNG (1320x2856, ~2.4 MB on this emulator), so the count *is* the disk
 * bound: 40 ≈ 96 MB per prefix, ~192 MB for the two together. A fixed count is what keeps the
 * directory from growing without bound.
 *
 * One capture costs ~1.6 s, so a burst of 20 screenshots (~35 s) would evict a deliberate shot taken
 * a minute earlier; 40 keeps a usable window. Raising it costs only disk, because a delivered image
 * is already durable in the attachment store — the PNG here is the original, not the record.
 */
export declare const SHOT_KEEP = 40;
/**
 * Keep only the newest `keep` automatic screenshots. Automatic shots exist for the failure that
 * just happened, so they are disposable — but only `auto-*` is ever deleted: the directory is
 * shared with hand-taken shots, and a tool that prunes user files is worse than a full disk.
 */
export declare function pruneAutoShots(dir: string, keep?: number): number;
/**
 * Keep only the newest `keep` captures the model tools took. Safe for the same reason
 * `pruneAutoShots` is: the prefix proves the plugin wrote the file (`hmos-shot-*`, the panel's and
 * the user's, is never matched here).
 */
export declare function pruneToolShots(dir: string, keep?: number): number;
/**
 * One slice of a long document, with the numbers a caller needs to page through it. Returns the
 * whole text when it already fits, and `nextOffset` only when there is more to read.
 */
export declare function sliceText(text: string, offset?: number, limit?: number): {
    text: string;
    total: number;
    offset: number;
    nextOffset: number | null;
};
/** One decoded PNG: 8-bit RGB(A) pixels, row-major, unfiltered. */
export interface DecodedPng {
    width: number;
    height: number;
    channels: number;
    pixels: Buffer;
}
/**
 * Decode a PNG far enough to compare pixels. `devecocli ui screenshot` writes one shape —
 * 1320x2856, 8 bit, colorType 6 (RGBA), interlace 0, filter 0 — and Node's zlib does the inflate, so
 * this stays dependency-free. Anything outside that shape is refused by name rather than guessed at.
 */
export declare function decodePng(file: Buffer): DecodedPng;
/**
 * Encode 8-bit RGB/RGBA pixels as a PNG, filter 0 on every row. The mirror of `decodePng`, and the
 * The one thing a region capture needs: devecocli has no crop option, so a region capture means cutting the
 * bitmap locally — which needs a way to write it back out. Deflate comes from `node:zlib`, so this
 * stays dependency-free like the decoder.
 */
export declare function encodePng(image: DecodedPng): Buffer;
/**
 * Cut a rectangle out of a decoded PNG, clamped to the image bounds. Returns the rectangle actually
 * used (`clamped: true` when it differs from the request), so a partly off-screen request is
 * reported rather than silently producing a different picture.
 */
export declare function cropPng(image: DecodedPng, rect: {
    x: number;
    y: number;
    w: number;
    h: number;
}): {
    image: DecodedPng;
    rect: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    clamped: boolean;
};
/**
 * Pixel difference between two captures, as the fraction of pixels whose channels differ at all.
 * Two captures of an unchanged screen are byte-identical , so callers get `same` from a
 * byte compare and never reach this function on the cheap path; it exists for the other case, where
 * "did that colour change actually land on screen, and how much" has to be a number rather than a
 * 268 KB image read into context.
 */
export declare function diffPng(before: DecodedPng, after: DecodedPng, tolerance?: number): {
    same: boolean;
    diffRatio: number;
    changedPixels: number;
    totalPixels: number;
};
export declare function apply(ctx: Ctx, _config?: any): void;
