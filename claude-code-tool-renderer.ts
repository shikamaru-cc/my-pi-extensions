import {
	AssistantMessageComponent,
	type BashToolDetails,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditToolDetails,
	type ExtensionAPI,
	type ReadToolDetails,
	ToolExecutionComponent,
} from "@mariozechner/pi-coding-agent";
import { Markdown, Text, type Component } from "@mariozechner/pi-tui";
import { relative } from "node:path";

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
	const bullet = theme.fg("accent", "●");
	if (!target) return `${bullet} ${theme.fg("toolTitle", label)}`;
	return `${bullet} ${theme.fg("toolTitle", `${label}(`)}${theme.fg("text", target)}${theme.fg("toolTitle", `)`)}`;
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

function patchToolSpacing(): void {
	const proto = ToolExecutionComponent.prototype as ToolExecutionComponent & {
		__compactToolSpacingPatched?: boolean;
		render(width: number): string[];
	};

	if (proto.__compactToolSpacingPatched) return;
	proto.__compactToolSpacingPatched = true;

	const originalRender = proto.render;
	proto.render = function (width: number): string[] {
		return trimBlankEdges(originalRender.call(this, width));
	};
}

function patchAssistantReplies(): void {
	const proto = AssistantMessageComponent.prototype as AssistantMessageComponent & {
		__assistantReplyPatched?: boolean;
		updateContent(message: any): void;
		contentContainer: { children: Component[] };
		markdownTheme: ConstructorParameters<typeof Markdown>[3];
	};

	if (proto.__assistantReplyPatched) return;
	proto.__assistantReplyPatched = true;

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
				contentContainer.children[childIndex] = new AssistantReplyBlock(
					new Markdown(content.text.trim(), 0, 0, this.markdownTheme),
					!usedBullet,
				);
				usedBullet = true;
				childIndex += 1;
				continue;
			}

			if (content.type === "thinking" && content.thinking.trim()) {
				childIndex += 1;
				if (hasVisibleAssistantContentAfter(message, i)) {
					childIndex += 1;
				}
			}
		}
	};
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	patchToolSpacing();
	patchAssistantReplies();

	const readTool = createReadTool(cwd);
	pi.registerTool({
		...readTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return readTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new Text(buildTitle(theme, "Read", toDisplayPath(args.path, context.cwd)), 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Text(theme.fg("muted", buildBlock("Reading...")), 0, 0);

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];
			if (!content) return new Text(theme.fg("muted", buildBlock("No output")), 0, 0);

			if (content.type === "image") {
				return new Text(theme.fg("muted", buildBlock(`Loaded image from ${toDisplayPath(context.args.path, context.cwd)}`)), 0, 0);
			}

			const lines = content.text.split("\n");
			let firstLine = `Read ${lines.length} lines from ${toDisplayPath(context.args.path, context.cwd)}`;
			if (details?.truncation?.truncated) {
				firstLine += ` (truncated from ${details.truncation.totalLines} lines)`;
			}

			const preview = options.expanded ? lines.slice(0, 14).map((line) => theme.fg("muted", line)) : [];
			if (options.expanded && lines.length > 14) {
				preview.push(theme.fg("dim", `... +${lines.length - 14} lines (ctrl+o to expand)`));
			}
			return new Text(buildBlock(theme.fg("muted", firstLine), preview), 0, 0);
		},
	});

	const bashTool = createBashTool(cwd);
	pi.registerTool({
		...bashTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(buildTitle(theme, "Bash", truncate(singleLine(args.command), 72)), 0, 0);
		},
		renderResult(result, options, theme) {
			if (options.isPartial) return new Text(theme.fg("muted", buildBlock("Running...")), 0, 0);

			const details = result.details as BashToolDetails | undefined;
			const output = result.content.find((item) => item.type === "text")?.text ?? "";
			const lines = output.split("\n");
			const exitMatch = output.match(/exit code: (\d+)/i);
			const exitCode = exitMatch ? Number.parseInt(exitMatch[1]!, 10) : 0;
			let firstLine = exitCode === 0 ? "Command finished" : `Command exited with code ${exitCode}`;
			if (details?.truncation?.truncated) firstLine += " (truncated)";

			const preview = options.expanded
				? lines.slice(0, 18).map((line) => theme.fg("muted", line))
				: lines.filter((line) => line.trim()).slice(0, 1).map((line) => theme.fg("muted", truncate(line, 120)));
			if (options.expanded && lines.length > 18) {
				preview.push(theme.fg("dim", `... +${lines.length - 18} lines (ctrl+o to expand)`));
			}

			const color = exitCode === 0 ? "muted" : "error";
			return new Text(buildBlock(theme.fg(color, firstLine), preview), 0, 0);
		},
	});

	const editTool = createEditTool(cwd);
	pi.registerTool({
		...editTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return editTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new Text(buildTitle(theme, "Edit", toDisplayPath(args.path, context.cwd)), 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Text(theme.fg("muted", buildBlock("Applying edits...")), 0, 0);

			const details = result.details as EditToolDetails | undefined;
			if (!details?.diff) {
				return new Text(buildBlock(theme.fg("muted", `Updated ${toDisplayPath(context.args.path, context.cwd)}`)), 0, 0);
			}

			const { additions, removals, lines } = summarizeDiff(details.diff);
			const firstLine = `${toDisplayPath(context.args.path, context.cwd)} updated (+${additions} / -${removals})`;
			const preview = options.expanded
				? lines.slice(0, 24).map((line) => {
					if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("success", line);
					if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("error", line);
					return theme.fg("muted", line);
				})
				: [];
			if (options.expanded && lines.length > 24) {
				preview.push(theme.fg("dim", `... +${lines.length - 24} diff lines (ctrl+o to expand)`));
			}

			return new Text(buildBlock(theme.fg("muted", firstLine), preview), 0, 0);
		},
	});

	const writeTool = createWriteTool(cwd);
	pi.registerTool({
		...writeTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return writeTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new Text(buildTitle(theme, "Write", toDisplayPath(args.path, context.cwd)), 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Text(theme.fg("muted", buildBlock("Writing...")), 0, 0);

			const path = toDisplayPath(context.args.path, context.cwd);
			const contentLines = context.args.content.split("\n");
			const resultText = result.content.find((item) => item.type === "text")?.text;
			const firstLine = resultText ? singleLine(resultText) : `Wrote ${contentLines.length} lines to ${path}`;
			const preview = options.expanded
				? contentLines.slice(0, 16).map((line, index) => theme.fg("muted", `${index + 1} ${line}`))
				: [];
			if (options.expanded && contentLines.length > 16) {
				preview.push(theme.fg("dim", `... +${contentLines.length - 16} lines (ctrl+o to expand)`));
			}
			return new Text(buildBlock(theme.fg("muted", firstLine), preview), 0, 0);
		},
	});
}
