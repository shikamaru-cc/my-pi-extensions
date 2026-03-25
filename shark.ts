import { VERSION, type ExtensionAPI, type Theme } from "@mariozechner/pi-coding-agent";

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

function getSharkAscii(theme: Theme): string[] {
	const muted = (value: string) => theme.fg("muted", value);
	const dim = (value: string) => theme.fg("dim", value);

	return [
		...renderAnsiHalf(SHARK_ART, SHARK_PALETTE),
		muted("   shark theme") + dim(` v${VERSION}`),
		muted("   pixel predator online") + dim(" • /shark-header-off to restore default header"),
		"",
	];
}

export default function sharkExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((_tui, theme) => ({
			render(_width: number): string[] {
				return getSharkAscii(theme);
			},
			invalidate() {},
		}));
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
					return getSharkAscii(theme);
				},
				invalidate() {},
			}));
			ctx.ui.notify("Enabled shark header", "info");
		},
	});
}
