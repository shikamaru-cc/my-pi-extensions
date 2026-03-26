import { VERSION, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hostname, platform, release } from "node:os";
import { fileURLToPath } from "node:url";

const SHARK_PALETTE: Record<string, string | null> = {
	".": null,
	A: "#0f1b3a",
	B: "#101938",
	C: "#0a1b3b",
	D: "#0d1938",
	E: "#04a1e5",
	F: "#747f97",
	G: "#05a1e1",
	H: "#03a2e3",
	I: "#05a3e4",
	J: "#0476b4",
	K: "#01a3e4",
	L: "#e5ebf3",
	M: "#1a7ab1",
	N: "#02a4e4",
	O: "#0d6ba2",
	P: "#08112a",
	Q: "#1c4363",
	R: "#04a3e4",
	S: "#0b98d8",
	T: "#01a4e8",
	U: "#01a2e6",
	V: "#000a18",
	W: "#000000",
	X: "#14233f",
	Y: "#0692d1",
	Z: "#01a3e3",
	a: "#000002",
	b: "#00a3e6",
	c: "#c9d8e3",
	d: "#c7e3ed",
	e: "#191531",
	f: "#64bbdf",
};

const SHARK_ART = [
	"..............A..........",
	".............BC..........",
	"............DEED.........",
	"...........FGHHD.........",
	"...........FIJJJCCC......",
	"...........FJJGKKKKCL....",
	"..........BMNKKKKKKKJOF..",
	".PQ.....QPMIKKKKKKKKKRS..",
	".DM.....QMIKKKKKKKKKKNI..",
	".DSB...BOIKKKKTUHHKKKKRC.",
	".DGNB..BSRKKKKVWLKKKKKHTA",
	"..QSBXBYUKNYNKVWWEKKHOKOD",
	"..QGGOYZKZOJTKVWaKKKEbUZD",
	"..cGHHEKKHOJbKERINNNd...B",
	"..cEHHNKSROJTKIHIHI.....B",
	"..QGGGSKSKOJI.........BBA",
	"..QGIddSGEOS..VD.Pe.XA.D.",
	".LOEMXcdfHUc...XeFFeDDXP.",
	".DGC...PMKNd....LLLL..c..",
	".DC....AGRRfd.......cdA..",
	"......DIRIAFddddddddAA...",
	"......DRYD.FDDDDDBBDMA...",
	".....XHHQ...........OA...",
	".....XAAc...........XA...",
];

function hexToRgb(hex: string): [number, number, number] {
	const value = hex.replace(/^#/, "");
	return [
		Number.parseInt(value.slice(0, 2), 16),
		Number.parseInt(value.slice(2, 4), 16),
		Number.parseInt(value.slice(4, 6), 16),
	];
}

function fgAnsi(hex: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\u001b[38;2;${r};${g};${b}m`;
}

function bgAnsi(hex: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\u001b[48;2;${r};${g};${b}m`;
}

function renderAnsiHalf(art: string[], palette: Record<string, string | null>): string[] {
	const reset = "\u001b[0m";
	const lines: string[] = [];
	const width = art[0]?.length ?? 0;

	for (let y = 0; y < art.length; y += 2) {
		let line = "";
		for (let x = 0; x < width; x++) {
			const top = art[y]?.[x] ?? ".";
			const bottom = art[y + 1]?.[x] ?? ".";
			const topColor = palette[top];
			const bottomColor = palette[bottom];

			if (!topColor && !bottomColor) {
				line += `${reset} `;
			} else if (topColor && !bottomColor) {
				line += `${reset}${fgAnsi(topColor)}▀`;
			} else if (!topColor && bottomColor) {
				line += `${reset}${fgAnsi(bottomColor)}▄`;
			} else if (topColor && bottomColor) {
				line += `${reset}${fgAnsi(topColor)}${bgAnsi(bottomColor)}▀`;
			}
		}
		lines.push(line + reset);
	}

	return lines;
}

type HeaderInfo = {
	model: string;
	cwd: string;
	workspace: string;
	session: string;
	host: string;
	node: string;
	time: string;
	command: string;
};

type UsageBucket = {
	bucketStart: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	calls: number;
};

type UsageStore = {
	version: 1;
	updatedAt: number;
	buckets: Record<string, UsageBucket>;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const RETENTION_MS = 14 * DAY_MS;
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const USAGE_STORE_PATH = join(EXTENSION_DIR, "usage-hourly.json");
const seenMessageKeys = new Set<string>();

function loadUsageStore(): UsageStore {
	if (!existsSync(USAGE_STORE_PATH)) {
		return { version: 1, updatedAt: Date.now(), buckets: {} };
	}

	try {
		const raw = readFileSync(USAGE_STORE_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<UsageStore>;
		return {
			version: 1,
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
			buckets: parsed.buckets ?? {},
		};
	} catch {
		return { version: 1, updatedAt: Date.now(), buckets: {} };
	}
}

function saveUsageStore(store: UsageStore): void {
	mkdirSync(EXTENSION_DIR, { recursive: true });
	writeFileSync(USAGE_STORE_PATH, JSON.stringify(store), "utf8");
}

function pruneUsageStore(store: UsageStore, now = Date.now()): UsageStore {
	const minBucket = Math.floor((now - RETENTION_MS) / HOUR_MS) * HOUR_MS;
	const buckets = Object.fromEntries(
		Object.entries(store.buckets).filter(([, bucket]) => bucket.bucketStart >= minBucket),
	);
	return { version: 1, updatedAt: now, buckets };
}

function recordUsage(timestamp: number, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }): void {
	const bucketStart = Math.floor(timestamp / HOUR_MS) * HOUR_MS;
	const bucketKey = String(bucketStart);
	const store = pruneUsageStore(loadUsageStore(), timestamp);
	const current = store.buckets[bucketKey] ?? {
		bucketStart,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		calls: 0,
	};

	current.input += usage.input;
	current.output += usage.output;
	current.cacheRead += usage.cacheRead;
	current.cacheWrite += usage.cacheWrite;
	current.total += usage.totalTokens;
	current.calls += 1;
	store.buckets[bucketKey] = current;
	store.updatedAt = timestamp;
	saveUsageStore(store);
}

function aggregateUsageWindow(store: UsageStore, windowMs: number, now = Date.now()): UsageBucket {
	const minTimestamp = now - windowMs;
	const result: UsageBucket = {
		bucketStart: Math.floor(now / HOUR_MS) * HOUR_MS,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		calls: 0,
	};

	for (const bucket of Object.values(store.buckets)) {
		if (bucket.bucketStart < minTimestamp) continue;
		result.input += bucket.input;
		result.output += bucket.output;
		result.cacheRead += bucket.cacheRead;
		result.cacheWrite += bucket.cacheWrite;
		result.total += bucket.total;
		result.calls += bucket.calls;
	}

	return result;
}

function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function getSharkAscii(theme: Theme, info: HeaderInfo): string[] {
	const white = (value: string) => `\u001b[97m${value}\u001b[0m`;
	const artLines = renderAnsiHalf(SHARK_ART, SHARK_PALETTE);
	const accent = fgAnsi("#01a3e4");
	const reset = "\u001b[0m";
	const shark = (value: string) => `${accent}\u001b[1m${value}${reset}`;
	const key = (label: string) => `${accent}${label}:${reset} `;
	const titleText = "shark your coding harness";
	const infoLines = [
		shark(titleText),
		white("-".repeat(titleText.length)),
		key("pi") + white(`v${VERSION}`),
		key("model") + white(info.model),
		key("directory") + white(info.cwd),
		key("workspace") + white(info.workspace),
		key("session") + white(info.session),
		key("host") + white(info.host),
		key("node") + white(info.node),
		key("time") + white(info.time),
		key("command") + white(info.command),
	];
	const gap = "   ";

	return artLines.map((line, index) => {
		const text = infoLines[index] ?? "";
		return text ? `${line}${gap}${text}` : line;
	});
}

function getHeaderInfo(ctx: ExtensionContext): HeaderInfo {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	const hh = String(now.getHours()).padStart(2, "0");
	const mi = String(now.getMinutes()).padStart(2, "0");
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "-";
	const sessionName = ctx.sessionManager.getSessionName?.() ?? ctx.sessionManager.getSessionId();

	return {
		model,
		cwd: ctx.cwd,
		workspace: basename(ctx.cwd) || ctx.cwd,
		session: sessionName,
		host: `${hostname()} ${platform()} ${release()}`,
		node: process.version,
		time: `${yyyy}-${mm}-${dd} ${hh}:${mi}`,
		command: "/shark-header-off",
	};
}

export default function sharkExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((_tui, theme) => ({
			render(_width: number): string[] {
				return getSharkAscii(theme, getHeaderInfo(ctx));
			},
			invalidate() {},
		}));
	});

	pi.on("message_end", async (event) => {
		const message = event.message as {
			role?: string;
			timestamp?: number;
			responseId?: string;
			usage?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				totalTokens: number;
			};
		};
		if (message.role !== "assistant" || !message.usage) return;
		if (message.usage.totalTokens <= 0) return;

		const messageKey = message.responseId ?? `${message.timestamp ?? Date.now()}:${message.usage.totalTokens}`;
		if (seenMessageKeys.has(messageKey)) return;
		seenMessageKeys.add(messageKey);
		if (seenMessageKeys.size > 512) {
			const oldest = seenMessageKeys.values().next().value;
			if (oldest) seenMessageKeys.delete(oldest);
		}

		recordUsage(message.timestamp ?? Date.now(), message.usage);
	});

	pi.registerCommand("shark-header-off", {
		description: "Restore pi's default startup header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Restored default header", "info");
		},
	});

	pi.registerCommand("shark-header-on", {
		description: "Enable the shark startup header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader((_tui, theme) => ({
				render(_width: number): string[] {
					return getSharkAscii(theme, getHeaderInfo(ctx));
				},
				invalidate() {},
			}));
			ctx.ui.notify("Enabled shark header", "info");
		},
	});

	pi.registerCommand("shark-usage", {
		description: "Show shark token usage for 5h, 1d, and 7d",
		handler: async (_args, ctx) => {
			const store = pruneUsageStore(loadUsageStore());
			saveUsageStore(store);

			const usage5h = aggregateUsageWindow(store, 5 * HOUR_MS);
			const usage1d = aggregateUsageWindow(store, DAY_MS);
			const usage7d = aggregateUsageWindow(store, WEEK_MS);
			const lines = [
				"shark usage",
				"-----------",
				`5h: ${formatTokenCount(usage5h.total)} tokens in ${usage5h.calls} calls`,
				`1d: ${formatTokenCount(usage1d.total)} tokens in ${usage1d.calls} calls`,
				`7d: ${formatTokenCount(usage7d.total)} tokens in ${usage7d.calls} calls`,
				"",
				`store: ${USAGE_STORE_PATH}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
