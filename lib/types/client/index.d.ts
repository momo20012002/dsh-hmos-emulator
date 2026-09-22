interface Ctx {
    get(name: string): any;
    effect(callback: () => any, label?: string): void;
}
declare const h: any, useEffect: any, useRef: any, useState: any;
declare const svg: (vb: any, body: any) => string;
declare const IC: {
    emulator: string;
    play: string;
    stop: string;
    refresh: string;
    scan: string;
    deploy: string;
    folder: string;
    clock: string;
    chevron: string;
    camera: string;
};
declare const API = "/dsh-hmos-emulator/api";
declare function rpc(method: string, body?: any): Promise<any>;
/** Panel-facing names of the four check modes, shared by the buttons and the status line. */
declare const LINT_TITLES: {
    changed: string;
    all: string;
    fix: string;
    'fix-all': string;
};
/** Elapsed time of a running step: "42s" below a minute, "1m12s" above. */
declare const fmtDur: (ms: number) => string;
declare const s: {
    fg: string;
    muted: string;
    faint: string;
    border: string;
    bg: string;
    bg2: string;
    accent: string;
    accentSoft: string;
    ok: string;
    danger: string;
    solid: string;
};
declare const row: {
    display: string;
    alignItems: string;
    gap: number;
    marginBottom: number;
    flexWrap: string;
};
declare const label: {
    fontSize: number;
    color: string;
    width: number;
    flex: string;
};
declare const field: {
    flex: number;
    minWidth: number;
    background: string;
    color: string;
    border: string;
    borderRadius: number;
    padding: string;
    fontSize: number;
    fontFamily: string;
};
declare const card: {
    background: string;
    border: string;
    borderRadius: number;
    padding: number;
    marginBottom: number;
};
declare const btnBase: {
    display: string;
    alignItems: string;
    justifyContent: string;
    gap: number;
    borderRadius: number;
    padding: string;
    fontSize: number;
    lineHeight: number;
    cursor: string;
    border: string;
    whiteSpace: string;
};
declare const btnPrimary: {
    background: string;
    color: string;
    display: string;
    alignItems: string;
    justifyContent: string;
    gap: number;
    borderRadius: number;
    padding: string;
    fontSize: number;
    lineHeight: number;
    cursor: string;
    border: string;
    whiteSpace: string;
};
declare const btnSecondary: {
    border: string;
    color: string;
    background: string;
    display: string;
    alignItems: string;
    justifyContent: string;
    gap: number;
    borderRadius: number;
    padding: string;
    fontSize: number;
    lineHeight: number;
    cursor: string;
    whiteSpace: string;
};
declare const btnGhost: {
    color: string;
    background: string;
    display: string;
    alignItems: string;
    justifyContent: string;
    gap: number;
    borderRadius: number;
    padding: string;
    fontSize: number;
    lineHeight: number;
    cursor: string;
    border: string;
    whiteSpace: string;
};
declare const btnDanger: {
    border: string;
    color: string;
    background: string;
    display: string;
    alignItems: string;
    justifyContent: string;
    gap: number;
    borderRadius: number;
    padding: string;
    fontSize: number;
    lineHeight: number;
    cursor: string;
    whiteSpace: string;
};
declare const btnDangerSolid: {
    background: string;
    color: string;
    display: string;
    alignItems: string;
    justifyContent: string;
    gap: number;
    borderRadius: number;
    padding: string;
    fontSize: number;
    lineHeight: number;
    cursor: string;
    border: string;
    whiteSpace: string;
};
declare const logLine: (kind: any) => {
    fontSize: number;
    lineHeight: number;
    whiteSpace: string;
    wordBreak: string;
    color: string;
};
declare const warnBox: {
    background: string;
    border: string;
    color: string;
    borderRadius: number;
    padding: number;
    fontSize: number;
    marginBottom: number;
    lineHeight: number;
};
/** Inline SVG icon forced to currentColor so it follows the theme. */
declare function Icon({ src, size }: {
    src: string;
    size?: number;
}): any;
/** Button with an optional leading icon. */
declare function Btn({ children, icon, primary, secondary, danger, dangerSolid, ghost, disabled, onClick, style, title }: {
    children?: any;
    icon?: string;
    primary?: boolean;
    secondary?: boolean;
    danger?: boolean;
    dangerSolid?: boolean;
    ghost?: boolean;
    disabled?: boolean;
    onClick?: any;
    style?: any;
    title?: string;
}): any;
/** Card block. action renders at the right of the title row; style overrides the card. */
declare function Card({ title, action, style, children }: {
    title?: string;
    action?: any;
    style?: any;
    children?: any;
}): any;
/** Themed dropdown: closed by default, opens on click; the list uses the dark surface. */
declare function Dropdown({ value, placeholder, options, onChange }: {
    value?: string;
    placeholder?: string;
    options?: {
        value: string;
        label: string;
        status?: string;
    }[];
    onChange?: (v: string) => void;
}): any;
declare let lastShot: any;
declare function Panel(props: {
    scope?: {
        sessionId?: string;
        cwd?: string;
    };
    ctx: Ctx;
}): any;
declare function apply(ctx: Ctx): void;
