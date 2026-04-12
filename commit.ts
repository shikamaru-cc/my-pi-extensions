import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type GitResult = {
	stdout: string;
	stderr: string;
	code: number;
};

type DiffSummary = {
	files: number;
	additions: number;
	deletions: number;
	hasBinary: boolean;
};

type CommitToolCall = {
	name: string;
	args: Record<string, unknown>;
};

type CommitStreamEntry =
	| { kind: "status"; text: string }
	| { kind: "tool"; text: string }
	| { kind: "text"; text: string }
	| { kind: "stderr"; text: string };

type CommitSubagentStreamHandlers = {
	onStatus?: (text: string) => void;
	onToolCall?: (toolCall: CommitToolCall) => void;
	onAssistantText?: (text: string) => void;
	onStderr?: (text: string) => void;
};

type CommitSubagentResult = {
	exitCode: number;
	stderr: string;
	finalOutput: string;
	stopReason?: string;
	errorMessage?: string;
	toolCalls: CommitToolCall[];
};

type CommitOutcome = "committed" | "no-commit" | "failed";

type CommitToolDetails = {
	phase: "running" | "done";
	repoCwd: string;
	branch: string;
	headBefore: string | null;
	headAfter: string | null;
	outcome?: CommitOutcome;
	outcomeLine?: string;
	commitSubject?: string | null;
	entries: CommitStreamEntry[];
	finalOutput: string;
	stderr: string;
	toolCalls: CommitToolCall[];
};

const GIT_TIMEOUT_MS = 30_000;
const MAX_INLINE_DIFF_CHARS = 16_000;
const MAX_INLINE_DIFF_FILES = 3;
const MAX_INLINE_DIFF_LINES = 150;
const MAX_UNTRACKED_FILES = 5;
const MAX_UNTRACKED_FILE_BYTES = 64_000;
const MAX_UNTRACKED_FILE_CHARS = 4_000;
const MAX_COLLAPSED_ENTRIES = 8;
const COMMIT_SUBAGENT_TOOLS = ["bash", "read", "edit", "write"];
const COMMIT_TOOL_NAME = "commit_subagent";

async function runGit(pi: ExtensionAPI, args: string[], cwd?: string): Promise<GitResult> {
	try {
		const gitArgs = cwd ? ["-C", cwd, ...args] : args;
		const result = await pi.exec("git", gitArgs, { timeout: GIT_TIMEOUT_MS });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			code: result.code ?? 1,
		};
	} catch (error) {
		return {
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			code: 1,
		};
	}
}

function clip(text: string, maxChars = MAX_INLINE_DIFF_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function shorten(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function hasFlag(args: string | undefined, flag: string): boolean {
	return (args ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.includes(flag);
}

function matchesGitCommitCommand(command: string): boolean {
	return /(^|[\n;&|])\s*git\s+commit\b/i.test(command);
}

function matchesGitPushCommand(command: string): boolean {
	return /(^|[\n;&|])\s*git\s+push\b/i.test(command);
}

function parseNullSeparated(output: string): string[] {
	return output.split("\0").filter((value) => value.length > 0);
}

function parseDiffSummary(output: string): DiffSummary {
	const lines = output.split(/\r?\n/).filter(Boolean);
	let additions = 0;
	let deletions = 0;
	let hasBinary = false;

	for (const line of lines) {
		const [added, deleted] = line.split("\t");
		if (added === undefined || deleted === undefined) continue;

		if (added === "-" || deleted === "-") {
			hasBinary = true;
			continue;
		}

		const addedCount = Number(added);
		const deletedCount = Number(deleted);

		if (Number.isFinite(addedCount)) additions += addedCount;
		else hasBinary = true;

		if (Number.isFinite(deletedCount)) deletions += deletedCount;
		else hasBinary = true;
	}

	return { files: lines.length, additions, deletions, hasBinary };
}

function uniqueSorted(items: string[]): string[] {
	return Array.from(new Set(items)).sort((left, right) => left.localeCompare(right));
}

function intersect(left: string[], right: string[]): string[] {
	const rightSet = new Set(right);
	return uniqueSorted(left.filter((item) => rightSet.has(item)));
}

function formatList(items: string[], empty = "(none)"): string {
	return items.length > 0 ? items.join("\n") : empty;
}

function formatDiffSummary(summary: DiffSummary): string {
	const suffix = summary.hasBinary ? ", binary changes present" : "";
	return `${summary.files} file(s), ${summary.additions} insertion(s), ${summary.deletions} deletion(s)${suffix}`;
}

function shouldInlineDiff(params: {
	trackedFiles: number;
	changedLines: number;
	hasBinary: boolean;
	partiallyStagedFiles: number;
}): boolean {
	return (
		params.trackedFiles > 0 &&
		params.trackedFiles <= MAX_INLINE_DIFF_FILES &&
		params.changedLines <= MAX_INLINE_DIFF_LINES &&
		!params.hasBinary &&
		params.partiallyStagedFiles === 0
	);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function writeTempPromptFile(content: string): Promise<{ dir: string; filePath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-commit-subagent-"));
	const filePath = join(dir, "commit-workflow.md");
	await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

function extractAssistantText(message: any): string {
	if (!message || !Array.isArray(message.content)) return "";
	const parts = message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text.trim())
		.filter(Boolean);
	return parts.join("\n\n").trim();
}

function extractToolCalls(message: any): CommitToolCall[] {
	if (!message || !Array.isArray(message.content)) return [];
	const result: CommitToolCall[] = [];
	for (const part of message.content) {
		if (!part || part.type !== "toolCall" || typeof part.name !== "string") continue;
		const args = part.arguments && typeof part.arguments === "object" ? (part.arguments as Record<string, unknown>) : {};
		result.push({ name: part.name, args });
	}
	return result;
}

async function startCommitSubagent(
	prompt: string,
	cwd: string,
	handlers: CommitSubagentStreamHandlers = {},
): Promise<{ result: Promise<CommitSubagentResult> }> {
	const tempPrompt = await writeTempPromptFile(prompt);
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--tools",
		COMMIT_SUBAGENT_TOOLS.join(","),
		"--append-system-prompt",
		tempPrompt.filePath,
		"Complete the /commit workflow now using the appended git context. Inspect files or run targeted diffs when needed, then either create one focused commit or explain why no commit should be made.",
	];

	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	handlers.onStatus?.("Subagent started.");

	const result = new Promise<CommitSubagentResult>((resolvePromise) => {
		let buffer = "";
		let stderr = "";
		let finalOutput = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		const toolCalls: CommitToolCall[] = [];

		const processLine = (line: string) => {
			if (!line.trim()) return;

			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = extractAssistantText(event.message);
				if (text) {
					finalOutput = text;
					handlers.onAssistantText?.(text);
				}

				const extractedToolCalls = extractToolCalls(event.message);
				for (const toolCall of extractedToolCalls) {
					toolCalls.push(toolCall);
					handlers.onToolCall?.(toolCall);
				}

				if (typeof event.message.stopReason === "string") stopReason = event.message.stopReason;
				if (typeof event.message.errorMessage === "string") errorMessage = event.message.errorMessage;
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			const text = data.toString();
			stderr += text;
			handlers.onStderr?.(text);
		});

		proc.on("close", async (code) => {
			if (buffer.trim()) processLine(buffer);
			handlers.onStatus?.("Subagent finished.");
			await rm(tempPrompt.dir, { recursive: true, force: true });
			resolvePromise({
				exitCode: code ?? 1,
				stderr: stderr.trim(),
				finalOutput,
				stopReason,
				errorMessage,
				toolCalls,
			});
		});

		proc.on("error", async (error) => {
			handlers.onStatus?.("Subagent failed to start.");
			await rm(tempPrompt.dir, { recursive: true, force: true });
			resolvePromise({
				exitCode: 1,
				stderr: error instanceof Error ? error.message : String(error),
				finalOutput,
				stopReason,
				errorMessage,
				toolCalls,
			});
		});
	});

	return { result };
}

function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
	return sample.includes(0);
}

async function buildUntrackedPreview(cwd: string, relativePath: string): Promise<string> {
	const absolutePath = resolve(cwd, relativePath);

	let fileStat;
	try {
		fileStat = await stat(absolutePath);
	} catch {
		return `File: ${relativePath}\n[Unable to read file metadata]`;
	}

	if (!fileStat.isFile()) return `File: ${relativePath}\n[Not a regular file]`;
	if (fileStat.size > MAX_UNTRACKED_FILE_BYTES) {
		return `File: ${relativePath}\n[Skipped preview: file is ${fileStat.size} bytes, larger than the ${MAX_UNTRACKED_FILE_BYTES}-byte preview limit]`;
	}

	let buffer: Buffer;
	try {
		buffer = await readFile(absolutePath);
	} catch {
		return `File: ${relativePath}\n[Unable to read file contents]`;
	}

	if (looksBinary(buffer)) return `File: ${relativePath}\n[Skipped preview: binary file]`;
	const content = clip(buffer.toString("utf8"), MAX_UNTRACKED_FILE_CHARS);
	return `File: ${relativePath}\n\n\`\`\`\n${content}\n\`\`\``;
}

function getHeadSha(result: GitResult): string | null {
	const value = result.stdout.trim();
	return result.code === 0 && value ? value : null;
}

function getOutcomeLine(text: string): string {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

function formatShortSha(sha: string | null): string {
	return sha ? sha.slice(0, 7) : "(none)";
}

function getOutcomeLabel(outcome: CommitOutcome): string {
	switch (outcome) {
		case "committed":
			return "Commit created";
		case "failed":
			return "Commit failed";
		default:
			return "No commit created";
	}
}

function getOutcomeText(theme: Theme, outcome: CommitOutcome, text: string): string {
	switch (outcome) {
		case "committed":
			return theme.fg("success", text);
		case "failed":
			return theme.fg("error", text);
		default:
			return theme.fg("warning", text);
	}
}

function formatCommitToolCallText(toolCall: CommitToolCall): string {
	switch (toolCall.name) {
		case "bash": {
			const command = typeof toolCall.args.command === "string" ? toolCall.args.command : "...";
			return `$ ${shorten(command, 140)}`;
		}
		case "read": {
			const path = typeof toolCall.args.path === "string" ? toolCall.args.path : "...";
			const offset = typeof toolCall.args.offset === "number" ? toolCall.args.offset : undefined;
			const limit = typeof toolCall.args.limit === "number" ? toolCall.args.limit : undefined;
			const range = offset !== undefined ? `:${offset}${limit !== undefined ? `-${offset + limit - 1}` : ""}` : "";
			return `read ${path}${range}`;
		}
		case "edit": {
			const path = typeof toolCall.args.path === "string" ? toolCall.args.path : "...";
			return `edit ${path}`;
		}
		case "write": {
			const path = typeof toolCall.args.path === "string" ? toolCall.args.path : "...";
			return `write ${path}`;
		}
		default:
			return `${toolCall.name} ${shorten(JSON.stringify(toolCall.args), 120)}`;
	}
}

function formatCommitToolCall(theme: Theme, toolCall: CommitToolCall): string {
	const text = formatCommitToolCallText(toolCall);
	if (text.startsWith("$ ")) {
		return `${theme.fg("muted", "$ ")}${theme.fg("toolOutput", text.slice(2))}`;
	}
	if (text.startsWith("read ")) {
		return `${theme.fg("muted", "read ")}${theme.fg("accent", text.slice(5))}`;
	}
	if (text.startsWith("edit ")) {
		return `${theme.fg("muted", "edit ")}${theme.fg("accent", text.slice(5))}`;
	}
	if (text.startsWith("write ")) {
		return `${theme.fg("muted", "write ")}${theme.fg("accent", text.slice(6))}`;
	}
	return `${theme.fg("dim", text)}`;
}

function formatEntry(theme: Theme, entry: CommitStreamEntry): string {
	switch (entry.kind) {
		case "status":
			return `${theme.fg("dim", entry.text)}`;
		case "tool":
			return `${theme.fg("muted", "→ ")}${entry.text}`;
		case "stderr":
			return `${theme.fg("error", entry.text)}`;
		default:
			return theme.fg("toolOutput", entry.text);
	}
}

function renderCommitToolResult(details: CommitToolDetails, options: { expanded?: boolean; isPartial?: boolean }, theme: Theme) {
	const expanded = options.expanded ?? false;
	const mdTheme = getMarkdownTheme();
	const container = new Container();
	const status =
		details.phase === "running"
			? theme.fg("warning", "running")
			: details.outcome
				? getOutcomeText(theme, details.outcome, getOutcomeLabel(details.outcome))
				: theme.fg("muted", "finished");

	const summary = [
		`${theme.fg("muted", "Status: ")}${status}`,
		`${theme.fg("muted", "Repo: ")}${details.repoCwd}`,
		`${theme.fg("muted", "Branch: ")}${details.branch}`,
		`${theme.fg("muted", "HEAD before: ")}${formatShortSha(details.headBefore)}`,
	];
	if (details.phase === "done") {
		summary.push(`${theme.fg("muted", "HEAD after: ")}${formatShortSha(details.headAfter)}`);
		if (details.commitSubject) {
			summary.push(`${theme.fg("muted", "Commit: ")}${details.commitSubject}`);
		}
	}
	container.addChild(new Text(summary.join("\n"), 0, 0));

	const visibleEntries = expanded ? details.entries : details.entries.slice(-MAX_COLLAPSED_ENTRIES);
	if (visibleEntries.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold(details.phase === "running" ? "Live activity" : "Activity")), 0, 0));
		container.addChild(new Text(visibleEntries.map((entry) => formatEntry(theme, entry)).join("\n"), 0, 0));
		if (!expanded && details.entries.length > visibleEntries.length) {
			container.addChild(new Text(theme.fg("dim", `(showing last ${visibleEntries.length} entries, expand for more)`), 0, 0));
		}
	}

	if (details.phase === "done" && details.finalOutput.trim()) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagent report")), 0, 0));
		container.addChild(new Markdown(details.finalOutput.trim(), 0, 0, mdTheme));
	}

	if (details.phase === "done" && details.stderr.trim()) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold("stderr")), 0, 0));
		container.addChild(new Text(theme.fg("error", details.stderr.trim()), 0, 0));
	}

	return container;
}

const CommitToolParams = Type.Object({
	cwd: Type.Optional(Type.String({ description: "Working directory to resolve the repository from." })),
	noVerify: Type.Optional(Type.Boolean({ description: "Allow git commit --no-verify." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: COMMIT_TOOL_NAME,
		label: "Commit Subagent",
		description: "Run the /commit workflow inside an isolated pi subagent and stream progress.",
		parameters: CommitToolParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const startCwd = params.cwd || ctx.cwd;
			const repoRoot = await runGit(pi, ["rev-parse", "--show-toplevel"], startCwd);
			if (repoRoot.code !== 0 || !repoRoot.stdout.trim()) {
				return {
					content: [{ type: "text", text: "Not a git repository." }],
					details: {
						phase: "done",
						repoCwd: startCwd,
						branch: "(unknown)",
						headBefore: null,
						headAfter: null,
						outcome: "failed",
						outcomeLine: "Not a git repository.",
						commitSubject: null,
						entries: [{ kind: "stderr", text: "Not a git repository." }],
						finalOutput: "Not a git repository.",
						stderr: repoRoot.stderr,
						toolCalls: [],
					} satisfies CommitToolDetails,
					isError: true,
				};
			}

			const repoCwd = repoRoot.stdout.trim();
			const status = await runGit(pi, ["status", "--short"], repoCwd);
			if (status.code !== 0) {
				return {
					content: [{ type: "text", text: "Unable to read git status." }],
					details: {
						phase: "done",
						repoCwd,
						branch: "(unknown)",
						headBefore: null,
						headAfter: null,
						outcome: "failed",
						outcomeLine: "Unable to read git status.",
						commitSubject: null,
						entries: [{ kind: "stderr", text: status.stderr || "Unable to read git status." }],
						finalOutput: "Unable to read git status.",
						stderr: status.stderr,
						toolCalls: [],
					} satisfies CommitToolDetails,
					isError: true,
				};
			}

			if (!status.stdout.trim()) {
				return {
					content: [{ type: "text", text: "There are no uncommitted changes." }],
					details: {
						phase: "done",
						repoCwd,
						branch: "(unknown)",
						headBefore: null,
						headAfter: null,
						outcome: "no-commit",
						outcomeLine: "There are no uncommitted changes.",
						commitSubject: null,
						entries: [{ kind: "status", text: "There are no uncommitted changes." }],
						finalOutput: "There are no uncommitted changes.",
						stderr: "",
						toolCalls: [],
					} satisfies CommitToolDetails,
				};
			}

			const headBefore = getHeadSha(await runGit(pi, ["rev-parse", "--verify", "HEAD"], repoCwd));
			const noVerify = params.noVerify ?? false;

			const [
				branch,
				recentLog,
				stagedStat,
				unstagedStat,
				stagedFilesResult,
				unstagedFilesResult,
				stagedNumstat,
				unstagedNumstat,
				untrackedFilesResult,
			] = await Promise.all([
				runGit(pi, ["branch", "--show-current"], repoCwd),
				runGit(pi, ["log", "--oneline", "-10"], repoCwd),
				runGit(pi, ["diff", "--cached", "--stat"], repoCwd),
				runGit(pi, ["diff", "--stat"], repoCwd),
				runGit(pi, ["diff", "--cached", "--name-only", "-z"], repoCwd),
				runGit(pi, ["diff", "--name-only", "-z"], repoCwd),
				runGit(pi, ["diff", "--cached", "--numstat"], repoCwd),
				runGit(pi, ["diff", "--numstat"], repoCwd),
				runGit(pi, ["ls-files", "--others", "--exclude-standard", "-z"], repoCwd),
			]);

			const stagedFiles = uniqueSorted(parseNullSeparated(stagedFilesResult.stdout));
			const unstagedFiles = uniqueSorted(parseNullSeparated(unstagedFilesResult.stdout));
			const untrackedFiles = uniqueSorted(
				untrackedFilesResult.code === 0 ? parseNullSeparated(untrackedFilesResult.stdout) : []
			);
			const partiallyStagedFiles = intersect(stagedFiles, unstagedFiles);
			const stagedSummary = parseDiffSummary(stagedNumstat.stdout);
			const unstagedSummary = parseDiffSummary(unstagedNumstat.stdout);
			const trackedChangedFiles = new Set([...stagedFiles, ...unstagedFiles]).size;
			const totalChangedFiles = new Set([...stagedFiles, ...unstagedFiles, ...untrackedFiles]).size;
			const changedLines =
				stagedSummary.additions +
				stagedSummary.deletions +
				unstagedSummary.additions +
				unstagedSummary.deletions;
			const hasBinaryChanges = stagedSummary.hasBinary || unstagedSummary.hasBinary;
			const inlineDiffIncluded = shouldInlineDiff({
				trackedFiles: trackedChangedFiles,
				changedLines,
				hasBinary: hasBinaryChanges,
				partiallyStagedFiles: partiallyStagedFiles.length,
			});

			let stagedDiffText = "(omitted; inspect with git diff --cached if needed)";
			let unstagedDiffText = "(omitted; inspect with git diff if needed)";

			if (inlineDiffIncluded) {
				const [stagedDiff, unstagedDiff] = await Promise.all([
					runGit(pi, ["diff", "--cached"], repoCwd),
					runGit(pi, ["diff"], repoCwd),
				]);
				stagedDiffText = clip(stagedDiff.stdout.trim() || "(empty)");
				unstagedDiffText = clip(unstagedDiff.stdout.trim() || "(empty)");
			}

			const previewTargets = untrackedFiles.slice(0, MAX_UNTRACKED_FILES);
			const untrackedPreviews = await Promise.all(previewTargets.map((file) => buildUntrackedPreview(repoCwd, file)));
			const omittedUntrackedCount = Math.max(0, untrackedFiles.length - previewTargets.length);

			const prompt = `You are running the /commit workflow in pi inside an isolated subagent.

Goals:
1. Review the current git changes.
2. Decide whether the work should be split into multiple commits.
3. Use the summary below first. Run git diff or inspect changed files only when you need more detail.
4. If nothing is staged, stage the files that belong in the recommended commit.
5. When the changes are suitable for a single focused commit, write a commit message that matches the repository's recent style and run git commit.
6. Do not push.
7. After finishing, report what you staged and the final commit message.

Rules:
- Prefer a single focused commit when appropriate.
- If the changes mix unrelated concerns, explain how to split them and stop without committing.
- Stage only the files that belong in the recommended commit.
- Be careful with partially staged files. Do not accidentally include unstaged hunks from the same file.
- If the repository has no commit history, treat this as an initial commit.
- If you commit, ${noVerify ? "you may use git commit --no-verify." : "use a normal git commit without --no-verify unless the user explicitly asks for it."}
- If the summary is not enough, inspect the changed files or run targeted git diff commands before committing.
- If a single focused commit is appropriate, do not ask follow-up questions or wait for approval; stage the files and run git commit in the same turn.
- Never run git push.
- Start your final response with one concise outcome line suitable for a notification, for example:
  - Committed: <commit message>
  - No commit: <reason>
  - Failed: <reason>

Git context:

Repository root:
${repoCwd}

Branch:
${branch.stdout.trim() || "(unknown)"}

Status:
${status.stdout.trim()}

Recent commits:
${recentLog.code === 0 && recentLog.stdout.trim() ? recentLog.stdout.trim() : "No commits yet (initial commit)."}

Staged diff stat:
${stagedStat.stdout.trim() || "(nothing staged)"}

Unstaged diff stat:
${unstagedStat.stdout.trim() || "(nothing unstaged)"}

Staged files:
${formatList(stagedFiles)}

Unstaged files:
${formatList(unstagedFiles)}

Partially staged files:
${formatList(partiallyStagedFiles)}

Untracked files:
${formatList(untrackedFiles)}

Change size summary:
- Staged: ${formatDiffSummary(stagedSummary)}
- Unstaged: ${formatDiffSummary(unstagedSummary)}
- Tracked changed files: ${trackedChangedFiles}
- Total changed files (including untracked): ${totalChangedFiles}
- Total changed lines: ${changedLines}
- Inline diff included: ${inlineDiffIncluded ? "yes" : "no"}

${
	inlineDiffIncluded
		? `Staged diff:\n${stagedDiffText}\n\nUnstaged diff:\n${unstagedDiffText}`
		: "Inline diffs were omitted to save context. Inspect files or run targeted diffs as needed before committing."
}

Untracked file previews:
${untrackedPreviews.length > 0 ? untrackedPreviews.join("\n\n") : "(none)"}${omittedUntrackedCount > 0 ? `\n\n[${omittedUntrackedCount} additional untracked file(s) omitted from preview]` : ""}`;

			const details: CommitToolDetails = {
				phase: "running",
				repoCwd,
				branch: branch.stdout.trim() || "(unknown)",
				headBefore,
				headAfter: headBefore,
				entries: [{ kind: "status", text: "Launching isolated commit subagent..." }],
				finalOutput: "",
				stderr: "",
				toolCalls: [],
			};
			const pushUpdate = () => {
				onUpdate?.({ content: [{ type: "text", text: details.entries.at(-1)?.text || "Running /commit..." }], details });
			};
			pushUpdate();

			const { result } = await startCommitSubagent(prompt, repoCwd, {
				onStatus: (text) => {
					details.entries = [...details.entries, { kind: "status", text }];
					pushUpdate();
				},
				onToolCall: (toolCall) => {
					details.toolCalls = [...details.toolCalls, toolCall];
					details.entries = [...details.entries, { kind: "tool", text: formatCommitToolCallText(toolCall) }];
					pushUpdate();
				},
				onAssistantText: (text) => {
					details.entries = [...details.entries, { kind: "text", text: shorten(text.replace(/\s+/g, " ").trim(), 220) }];
					pushUpdate();
				},
				onStderr: (text) => {
					const nextEntries = text
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter(Boolean)
						.map((line) => ({ kind: "stderr", text: line }) as CommitStreamEntry);
					details.entries = [...details.entries, ...nextEntries];
					details.stderr = `${details.stderr}${text}`;
					pushUpdate();
				},
			});

			const subagentResult = await result;
			const headAfter = getHeadSha(await runGit(pi, ["rev-parse", "--verify", "HEAD"], repoCwd));
			const createdCommit = headAfter !== null && headAfter !== headBefore;
			const isError =
				subagentResult.exitCode !== 0 ||
				subagentResult.stopReason === "error" ||
				subagentResult.stopReason === "aborted";
			const outcome: CommitOutcome = isError ? "failed" : createdCommit ? "committed" : "no-commit";
			const commitSubjectResult = createdCommit ? await runGit(pi, ["log", "-1", "--format=%s", headAfter!], repoCwd) : null;
			const commitSubject = commitSubjectResult && commitSubjectResult.code === 0 ? commitSubjectResult.stdout.trim() : null;
			const finalText = subagentResult.finalOutput || subagentResult.errorMessage || subagentResult.stderr || "(no output)";

			details.phase = "done";
			details.headAfter = headAfter;
			details.outcome = outcome;
			details.outcomeLine = getOutcomeLine(finalText);
			details.commitSubject = commitSubject;
			details.finalOutput = finalText;
			details.stderr = subagentResult.stderr;
			details.toolCalls = subagentResult.toolCalls;
			pushUpdate();

			return {
				content: [{ type: "text", text: finalText }],
				details,
				isError: outcome === "failed",
			};
		},
		renderCall(args, theme) {
			const cwd = typeof args.cwd === "string" ? args.cwd : ".";
			const noVerify = args.noVerify === true ? theme.fg("warning", " --no-verify") : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("commit-subagent "))}${theme.fg("accent", cwd)}${noVerify}`,
				0,
				0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as CommitToolDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			return renderCommitToolResult(details, options, theme);
		},
	});

	pi.registerCommand("commit", {
		description: "Run the commit workflow in an isolated subagent tool",
		getArgumentCompletions: (prefix) => {
			const options = [{ value: "--no-verify", label: "--no-verify" }];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const noVerify = hasFlag(args, "--no-verify");
			pi.sendUserMessage(
				`Use the ${COMMIT_TOOL_NAME} tool now with cwd: ${JSON.stringify(ctx.cwd)} and noVerify: ${noVerify}. This tool already performs the full /commit workflow inside an isolated subagent, so do not inspect the repository yourself before calling it. After the tool finishes, briefly report the outcome in one sentence.`,
			);
		},
	});

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command?.trim() ?? "";

		if (matchesGitPushCommand(command)) {
			return { block: true, reason: "git push is disabled by the commit extension." };
		}

		if (matchesGitCommitCommand(command)) {
			return;
		}
	});
}
