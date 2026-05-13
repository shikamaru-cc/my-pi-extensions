import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { relative } from "node:path";

type AnyToolDefinition = ToolDefinition<any, any>;

const PARTIAL_LABELS: Record<string, string> = {
	read: "Reading...",
	bash: "Running...",
	edit: "Applying edits...",
	write: "Writing...",
	grep: "Searching...",
	find: "Finding...",
	ls: "Listing...",
};

function toDisplayPath(path: string | undefined, cwd: string): string {
	if (!path) return "...";
	if (path.startsWith("/")) {
		const rel = relative(cwd, path);
		if (rel && !rel.startsWith("..")) return rel || ".";
	}
	return path;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function buildTitle(theme: any, label: string, target?: string): string {
	const bullet = theme.fg("accent", "● ");
	if (!target) return `${bullet}${theme.fg("toolTitle", label)}`;
	const lines = target.split("\n");
	if (lines.length === 1) {
		return `${bullet}${theme.fg("toolTitle", `${label} `)}${theme.fg("text", target)}`;
	}
	return [
		`${bullet}${theme.fg("toolTitle", label)}`,
		...lines.map((line, index) => theme.fg("text", `${index === 0 ? "  └ " : "    "}${line}`)),
	].join("\n");
}

function buildBlock(firstLine: string, previewLines: string[] = []): string {
	const lines = [`  └ ${firstLine}`];
	for (const line of previewLines) lines.push(`    ${line}`);
	return lines.join("\n");
}

function getTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}

function getLines(text: string): string[] {
	return text === "" ? [] : text.split("\n");
}

function getNonEmptyLines(text: string): string[] {
	return getLines(text).filter((line) => line.trim().length > 0);
}

function getToolLabel(name: string): string {
	return name;
}

function getToolTarget(name: string, args: any, cwd: string): string | undefined {
	switch (name) {
			case "bash":
			return String(args.command ?? "").trim();
		case "read":
		case "write":
		case "edit":
		case "ls":
			return toDisplayPath(args.path, cwd);
		case "grep":
			return truncate(singleLine(args.pattern ?? args.query ?? ""), 72);
		case "find":
			return truncate(singleLine(args.pattern ?? args.path ?? ""), 72);
		default:
			return undefined;
	}
}

function formatPreview(lines: string[], limit: number, theme: any, expanded: boolean): string[] {
	const displayLines = expanded ? lines : lines.slice(0, limit);
	const preview = displayLines.map((line) => theme.fg("muted", line));
	if (!expanded && lines.length > limit) {
		preview.push(theme.fg("dim", `... +${lines.length - limit} lines (ctrl+o to expand)`));
	}
	return preview;
}

function summarizeDiff(diff: string): { additions: number; removals: number; lines: string[] } {
	const lines = diff.split("\n");
	let additions = 0;
	let removals = 0;
	for (const line of lines) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return { additions, removals, lines };
}

function summarizeToolResult(name: string, args: any, result: any, theme: any, cwd: string, expanded: boolean) {
	const text = getTextContent(result);
	const lines = getLines(text);
	const nonEmptyLines = getNonEmptyLines(text);

	switch (name) {
		case "read": {
			const image = result.content?.find((item: any) => item.type === "image");
			if (image) {
				return {
					firstLine: `Loaded image from ${toDisplayPath(args.path, cwd)}`,
					preview: [],
				};
			}
			let firstLine = `Read ${lines.length} lines from ${toDisplayPath(args.path, cwd)}`;
			if (result.details?.truncation?.truncated) {
				firstLine += ` (truncated from ${result.details.truncation.totalLines} lines)`;
			}
			return {
				firstLine,
				preview: expanded ? formatPreview(lines, 14, theme, true) : [],
			};
		}

		case "bash": {
			const exitMatch = text.match(/exit code: (\d+)/i);
			const exitCode = exitMatch ? Number.parseInt(exitMatch[1]!, 10) : 0;
			let firstLine = exitCode === 0 ? "Command finished" : `Command exited with code ${exitCode}`;
			if (result.details?.truncation?.truncated) firstLine += " (truncated)";
			const preview = expanded
				? formatPreview(lines, 18, theme, true)
				: nonEmptyLines.slice(0, 1).map((line) => theme.fg("muted", truncate(line, 120)));
			return { firstLine, preview };
		}

		case "edit": {
			if (!result.details?.diff) {
				return {
					firstLine: singleLine(text) || `Updated ${toDisplayPath(args.path, cwd)}`,
					preview: [],
				};
			}
			const { additions, removals, lines: diffLines } = summarizeDiff(result.details.diff);
			return {
				firstLine: `${toDisplayPath(args.path, cwd)} updated (+${additions} / -${removals})`,
				preview: expanded
					? diffLines.slice(0, 24).map((line) => {
						if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("success", line);
						if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("error", line);
						return theme.fg("muted", line);
					})
					: [],
			};
		}

		case "write": {
			const contentLines = String(args.content ?? "").split("\n");
			const firstLine = singleLine(text) || `Wrote ${contentLines.length} lines to ${toDisplayPath(args.path, cwd)}`;
			return {
				firstLine,
				preview: expanded
					? contentLines.slice(0, 16).map((line, index) => theme.fg("muted", `${index + 1} ${line}`))
					: [],
			};
		}

		case "grep":
			return {
				firstLine: `Found ${nonEmptyLines.length} matching lines`,
				preview: expanded ? formatPreview(lines, 18, theme, true) : [],
			};

		case "find":
			return {
				firstLine: `Found ${nonEmptyLines.length} paths`,
				preview: expanded ? formatPreview(lines, 18, theme, true) : [],
			};

		case "ls":
			return {
				firstLine: `Listed ${nonEmptyLines.length} entries in ${toDisplayPath(args.path, cwd)}`,
				preview: expanded ? formatPreview(lines, 18, theme, true) : [],
			};

		default:
			return {
				firstLine: singleLine(text) || "Done",
				preview: expanded ? formatPreview(lines, 18, theme, true) : [],
			};
	}
}

function decorateTool(definition: AnyToolDefinition): AnyToolDefinition {
	return {
		...definition,
		renderShell: definition.name === "edit" ? "default" : definition.renderShell,
		renderCall(args, theme, context) {
			return new Text(buildTitle(theme, getToolLabel(definition.name), getToolTarget(definition.name, args, context.cwd)), 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) {
				return new Text(theme.fg("muted", buildBlock(PARTIAL_LABELS[definition.name] ?? "Working...")), 0, 0);
			}

			const summary = summarizeToolResult(definition.name, context.args, result, theme, context.cwd, options.expanded);
			const color = context.isError ? "error" : "muted";
			return new Text(buildBlock(theme.fg(color, summary.firstLine), summary.preview), 0, 0);
		},
	};
}

export function registerToolDisplayOverrides(pi: ExtensionAPI, cwd = process.cwd()): void {
	const builtInDefinitions = [
		createReadToolDefinition(cwd),
		createBashToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];

	for (const definition of builtInDefinitions) {
		pi.registerTool(decorateTool(definition));
	}
}
