import {
	createBashToolDefinition,
	InteractiveMode,
	UserMessageComponent,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	ToolExecutionComponent,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Box, Editor, Markdown, Spacer, Text, visibleWidth, type Component } from "@mariozechner/pi-tui";
import { relative } from "node:path";

type AnyToolDefinition = ToolDefinition<any, any>;

type ThemeLike = {
	fg: (color: string, text: string) => string;
	toolTitle: (text: string) => string;
};


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
	return `${bullet}${theme.fg("toolTitle", `${label} `)}${theme.fg("text", target)}`;
}

function buildBlock(firstLine: string, previewLines: string[] = []): string {
	const lines = [`  └ ${firstLine}`];
	for (const line of previewLines) lines.push(`    ${line}`);
	return lines.join("\n");
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

function stripAnsi(value: string): string {
	return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function isBlankLine(value: string): boolean {
	return stripAnsi(value).trim().length === 0;
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && isBlankLine(lines[start] ?? "")) start++;
	while (end > start && isBlankLine(lines[end - 1] ?? "")) end--;

	const trimmed = lines.slice(start, end);
	const hadLeadingBlank = start > 0;
	if (hadLeadingBlank) trimmed.unshift("");
	return trimmed;
}


function trimAllBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankLine(lines[start] ?? "")) start++;
	while (end > start && isBlankLine(lines[end - 1] ?? "")) end--;
	return lines.slice(start, end);
}

function applyBackgroundToFullLine(line: string, width: number, bgColor?: (text: string) => string): string {
	if (!bgColor) return line;
	const paddingNeeded = Math.max(0, width - visibleWidth(line));
	return bgColor(line + " ".repeat(paddingNeeded));
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
			return truncate(singleLine(args.command ?? ""), 72);
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

function formatExpandedPreview(lines: string[], limit: number, theme: any): string[] {
	const preview = lines.slice(0, limit).map((line) => theme.fg("muted", line));
	if (lines.length > limit) {
		preview.push(theme.fg("dim", `... +${lines.length - limit} lines (ctrl+o to expand)`));
	}
	return preview;
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
				preview: expanded ? formatExpandedPreview(lines, 14, theme) : [],
			};
		}

		case "bash": {
			const exitMatch = text.match(/exit code: (\d+)/i);
			const exitCode = exitMatch ? Number.parseInt(exitMatch[1]!, 10) : 0;
			let firstLine = exitCode === 0 ? "Command finished" : `Command exited with code ${exitCode}`;
			if (result.details?.truncation?.truncated) firstLine += " (truncated)";
			const preview = expanded
				? formatExpandedPreview(lines, 18, theme)
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
				preview: expanded ? formatExpandedPreview(lines, 18, theme) : [],
			};

		case "find":
			return {
				firstLine: `Found ${nonEmptyLines.length} paths`,
				preview: expanded ? formatExpandedPreview(lines, 18, theme) : [],
			};

		case "ls":
			return {
				firstLine: `Listed ${nonEmptyLines.length} entries in ${toDisplayPath(args.path, cwd)}`,
				preview: expanded ? formatExpandedPreview(lines, 18, theme) : [],
			};

		default:
			return {
				firstLine: singleLine(text) || "Done",
				preview: expanded ? formatExpandedPreview(lines, 18, theme) : [],
			};
	}
}

function decorateTool(definition: AnyToolDefinition): AnyToolDefinition {
	return {
		...definition,
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

function patchToolSpacing(): void {
	const proto = ToolExecutionComponent.prototype as ToolExecutionComponent & {
		__compactToolSpacingPatched?: boolean;
		render(width: number): string[];
		updateDisplay(): void;
		contentBox: any;
		contentText: any;
	};

	if (proto.__compactToolSpacingPatched) return;
	proto.__compactToolSpacingPatched = true;

	// Patch updateDisplay: zero out Box padding + remove background
	const originalUpdateDisplay = proto.updateDisplay;
	proto.updateDisplay = function (): void {
		originalUpdateDisplay.call(this);
		this.contentBox.setBgFn(undefined);
		this.contentText.setCustomBgFn(undefined);
	};

	const originalRender = proto.render;
	proto.render = function (width: number): string[] {
		return trimBlankEdges(originalRender.call(this, width));
	};
}

function patchWidgetSpacing(): void {
	const proto = InteractiveMode.prototype as any;
	if (proto.__widgetSpacingPatched) return;
	proto.__widgetSpacingPatched = true;

	if (typeof proto.renderWidgets === "function") {
		proto.renderWidgets = function (): void {
			if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
			this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
			this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
			this.ui.requestRender();
		};
	}
}

function patchEditorPrompt(): void {
	const proto = Editor.prototype as any;
	if (proto.__editorPromptPatched) return;
	proto.__editorPromptPatched = true;

	const origRender = proto.render;
	proto.render = function (width: number): string[] {
		const promptWidth = 1;
		const innerWidth = Math.max(1, width - promptWidth);
		const lines = origRender.call(this, innerWidth) as string[];
		if (!Array.isArray(lines) || lines.length < 3) return lines;

		let autocompleteLineCount = 0;
		if (this.autocompleteState && this.autocompleteList) {
			try {
				autocompleteLineCount = this.autocompleteList.render(innerWidth).length;
			} catch {
				autocompleteLineCount = 0;
			}
		}

		const bottomBorderIndex = Math.max(1, lines.length - autocompleteLineCount - 1);
		const borderSuffix = this.borderColor?.("─".repeat(promptWidth)) ?? "─".repeat(promptWidth);
		const top = `${lines[0] ?? ""}${borderSuffix}`;
		const bottom = `${lines[bottomBorderIndex] ?? ""}${borderSuffix}`;
		const contentLines = lines.slice(1, bottomBorderIndex).map((line) => ` ${line}`);
		const autocompleteLines = lines.slice(bottomBorderIndex + 1).map((line) => `${" ".repeat(promptWidth)}${line}`);

		return [top, ...contentLines, bottom, ...autocompleteLines];
	};
}

function patchUserMessages(): void {
	const proto = UserMessageComponent.prototype as UserMessageComponent & {
		__userMessagePatched?: boolean;
		children: Component[];
		render(width: number): string[];
	};
	if (proto.__userMessagePatched) return;
	proto.__userMessagePatched = true;

	proto.render = function (width: number): string[] {
		const OSC133_ZONE_START = "\x1b]133;A\x07";
		const OSC133_ZONE_END = "\x1b]133;B\x07";
		const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
		const contentBox = this.children[0] as any;
		const sourceMarkdown = contentBox?.children?.[0] ?? this.children[1] as any;
		if (!sourceMarkdown) return [];

		const markdownText = String(sourceMarkdown.text ?? "");
		const markdownTheme = sourceMarkdown.theme;
		const sourceStyle = sourceMarkdown.defaultTextStyle ?? {};
		const userBgColor = contentBox?.bgFn as ((text: string) => string) | undefined;
		const plainMarkdown = new Markdown(markdownText, 0, 0, markdownTheme, {
			color: sourceStyle.color,
			bold: sourceStyle.bold,
			italic: sourceStyle.italic,
			strikethrough: sourceStyle.strikethrough,
			underline: sourceStyle.underline,
		});

		const innerWidth = Math.max(1, width - 1);
		const rendered = trimAllBlankEdges(plainMarkdown.render(innerWidth));
		const prefixed = rendered.map((line) => {
			const withPrefix = ` ${line}`;
			return applyBackgroundToFullLine(withPrefix, width, userBgColor);
		});
		const result = [...prefixed];
		if (result.length > 0) {
			result[0] = OSC133_ZONE_START + result[0];
			result[result.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + result[result.length - 1];
		}
		return result;
	};
}

export function applySimpleUiPatches(): void {
	patchWidgetSpacing();
	patchEditorPrompt();
	patchUserMessages();
	patchToolSpacing();
}
