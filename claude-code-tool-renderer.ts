import {
	AssistantMessageComponent,
	createBashToolDefinition,
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
import { Box, Editor, Markdown, Text, visibleWidth, type Component } from "@mariozechner/pi-tui";
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
	return `${bullet}${theme.fg("toolTitle", `${label}(`)}${theme.fg("text", target)}${theme.fg("toolTitle", `)`)}`;
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

function trimLeadingBlankLines(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length && isBlankLine(lines[start] ?? "")) start++;
	return lines.slice(start);
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
	switch (name) {
		case "ls":
			return "Ls";
		default:
			return name.charAt(0).toUpperCase() + name.slice(1);
	}
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

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandableComponent(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof (obj as any).setExpanded === "function";
}

function setExpandedRecursive(component: unknown, expanded: boolean): void {
	if (isExpandableComponent(component)) {
		(component as any).setExpanded(expanded);
	}
	// Penetrate Box/Container wrappers
	if (typeof component === "object" && component !== null && "children" in component) {
		for (const child of (component as any).children as unknown[]) {
			setExpandedRecursive(child, expanded);
		}
	}
}

function hasVisibleAssistantContent(message: any): boolean {
	return message.content.some(
		(c: any) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
	);
}

function hasVisibleAssistantContentAfter(message: any, index: number): boolean {
	return message.content
		.slice(index + 1)
		.some((c: any) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
}

class AssistantReplyBlock implements Component {
	constructor(
		private child: Component,
		private showBullet: boolean,
	) {}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const lines = trimLeadingBlankLines(this.child.render(innerWidth));
		let seenFirstVisible = false;
		const rendered = lines.map((line) => {
			if (!seenFirstVisible && !isBlankLine(line)) {
				seenFirstVisible = true;
				return `${this.showBullet ? "● " : "  "}${line}`;
			}
			if (!seenFirstVisible) return line;
			return isBlankLine(line) ? "" : `  ${line}`;
		});
		return rendered;
	}

	invalidate(): void {
		this.child.invalidate?.();
	}

	handleInput?(data: string): void {
		this.child.handleInput?.(data);
	}
}

function getLastNonEmptyLine(thinking: string): string | null {
	const lines = thinking.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	return lines.length > 0 ? lines[lines.length - 1]! : null;
}

class ThinkingPreviewBlock implements Component {
	private text = new Text("", 0, 0);
	private expanded = false;

	constructor(private thinking: string) {}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	render(width: number): string[] {
		if (this.expanded) {
			const bodyLines = this.thinking
				.replace(/\r/g, "")
				.split("\n")
				.map((line) => `\x1b[38;5;245m  ${line}\x1b[39m`);
			this.text.setText(["\x1b[38;5;245m∴ Thinking\x1b[39m", "", ...bodyLines].join("\n"));
		} else {
			const lastLine = getLastNonEmptyLine(this.thinking);
			const lines = lastLine
				? ["\x1b[38;5;245m∴ Thinking\x1b[39m", "", `\x1b[38;5;245m  ${lastLine}\x1b[39m`]
				: ["\x1b[38;5;245m∴ Thinking…\x1b[39m"];
			this.text.setText(lines.join("\n"));
		}
		return this.text.render(width);
	}

	invalidate(): void {
		this.text.invalidate?.();
	}
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
		this.contentBox.paddingX = 0;
		this.contentBox.paddingY = 0;
		originalUpdateDisplay.call(this);
		this.contentBox.setBgFn(undefined);
		this.contentText.setCustomBgFn(undefined);
	};

	const originalRender = proto.render;
	proto.render = function (width: number): string[] {
		return trimBlankEdges(originalRender.call(this, width));
	};
}

function patchAssistantReplies(): void {
	const proto = AssistantMessageComponent.prototype as AssistantMessageComponent &
		Expandable & {
			__assistantReplyPatched?: boolean;
			updateContent(message: any): void;
			contentContainer: { children: Component[] };
			markdownTheme: ConstructorParameters<typeof Markdown>[3];
		};

	if (proto.__assistantReplyPatched) return;
	proto.__assistantReplyPatched = true;

	// Make AssistantMessageComponent expandable so ctrl+o propagates to ThinkingPreviewBlocks
	proto.setExpanded = function (expanded: boolean): void {
		const contentContainer = this.contentContainer;
		if (!contentContainer?.children) return;
		for (const child of contentContainer.children) {
			setExpandedRecursive(child, expanded);
		}
	};

	const originalUpdateContent = proto.updateContent;
	proto.updateContent = function (message: any): void {
		originalUpdateContent.call(this, message);

		const contentContainer = this.contentContainer;
		if (!contentContainer?.children) return;
		if (!hasVisibleAssistantContent(message)) return;

		let childIndex = 1; // Original component inserts a leading Spacer(1)
		let usedBullet = false;

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				contentContainer.children[childIndex] = new AssistantReplyBlock(new Markdown(content.text.trim(), 0, 0, this.markdownTheme), !usedBullet);
				usedBullet = true;
				childIndex += 1;
				continue;
			}

			if (content.type === "thinking" && content.thinking.trim()) {
				contentContainer.children[childIndex] = new ThinkingPreviewBlock(content.thinking);
				childIndex += 1;
				if (hasVisibleAssistantContentAfter(message, i)) {
					childIndex += 1;
				}
			}
		}
	};
}

function patchTextPadding(): void {
	const proto = Text.prototype as any;
	if (proto.__textPaddingPatched) return;
	proto.__textPaddingPatched = true;

	const origRender = proto.render;
	proto.render = function (width: number): string[] {
		this.paddingX = 0;
		return origRender.call(this, width);
	};
}

function patchEditorPrompt(): void {
	const proto = Editor.prototype as any;
	if (proto.__editorPromptPatched) return;
	proto.__editorPromptPatched = true;

	const origRender = proto.render;
	proto.render = function (width: number): string[] {
		const promptWidth = 2;
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
		const contentLines = lines.slice(1, bottomBorderIndex).map((line, index) => `${index === 0 ? "> " : "  "}${line}`);
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
		const sourceMarkdown = this.children[1] as any;
		if (!sourceMarkdown) return [];

		const markdownText = String(sourceMarkdown.text ?? "");
		const markdownTheme = sourceMarkdown.theme;
		const sourceStyle = sourceMarkdown.defaultTextStyle ?? {};
		const plainMarkdown = new Markdown(markdownText, 0, 0, markdownTheme, {
			color: sourceStyle.color,
			bgColor: sourceStyle.bgColor,
			bold: sourceStyle.bold,
			italic: sourceStyle.italic,
			strikethrough: sourceStyle.strikethrough,
			underline: sourceStyle.underline,
		});

		const innerWidth = Math.max(1, width - 2);
		const rendered = trimAllBlankEdges(plainMarkdown.render(innerWidth));
		const prefixed = rendered.map((line, index) => {
			const withPrefix = `${index === 0 ? "> " : "  "}${line}`;
			return applyBackgroundToFullLine(withPrefix, width, sourceStyle.bgColor);
		});
		const result = ["", ...prefixed];
		if (result.length > 0) {
			result[0] = OSC133_ZONE_START + result[0];
			result[result.length - 1] = result[result.length - 1] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
		}
		return result;
	};
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	patchTextPadding();
	patchEditorPrompt();
	patchUserMessages();
	patchToolSpacing();
	patchAssistantReplies();

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
