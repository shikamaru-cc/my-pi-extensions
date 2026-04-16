import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { applySimpleUiPatches } from "./patches.js";
import { registerToolDisplayOverrides } from "./tool-rendering.js";

export default function (pi: ExtensionAPI) {
	applySimpleUiPatches();
	registerToolDisplayOverrides(pi, process.cwd());
}
