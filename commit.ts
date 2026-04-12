import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

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

type CommitSubagentResult = {
	exitCode: number;
	stderr: string;
	finalOutput: string;
	stopReason?: string;
	errorMessage?: string;
};

const GIT_TIMEOUT_MS = 30_000;
const MAX_INLINE_DIFF_CHARS = 16_000;
const MAX_INLINE_DIFF_FILES = 3;
const MAX_INLINE_DIFF_LINES = 150;
const MAX_UNTRACKED_FILES = 5;
const MAX_UNTRACKED_FILE_BYTES = 64_000;
const MAX_UNTRACKED_FILE_CHARS = 4_000;
const SUBAGENT_NOTIFICATION_CHARS = 180;
const COMMIT_SUBAGENT_TOOLS = ["bash", "read", "edit", "write"];

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

function clipNotification(text: string, maxChars = SUBAGENT_NOTIFICATION_CHARS): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (!oneLine) return "";
	if (oneLine.length <= maxChars) return oneLine;
	return `${oneLine.slice(0, maxChars - 1)}…`;
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

		if (Number.isFinite(addedCount)) {
			additions += addedCount;
		} else {
			hasBinary = true;
		}

		if (Number.isFinite(deletedCount)) {
			deletions += deletedCount;
		} else {
			hasBinary = true;
		}
	}

	return {
		files: lines.length,
		additions,
		deletions,
		hasBinary,
	};
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
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

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

async function runCommitSubagent(prompt: string, cwd: string): Promise<CommitSubagentResult> {
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

	try {
		return await new Promise<CommitSubagentResult>((resolvePromise) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let stderr = "";
			let finalOutput = "";
			let stopReason: string | undefined;
			let errorMessage: string | undefined;

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
					if (text) finalOutput = text;
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
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolvePromise({
					exitCode: code ?? 1,
					stderr: stderr.trim(),
					finalOutput,
					stopReason,
					errorMessage,
				});
			});

			proc.on("error", (error) => {
				resolvePromise({
					exitCode: 1,
					stderr: error instanceof Error ? error.message : String(error),
					finalOutput,
					stopReason,
					errorMessage,
				});
			});
		});
	} finally {
		await rm(tempPrompt.dir, { recursive: true, force: true });
	}
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

	if (!fileStat.isFile()) {
		return `File: ${relativePath}\n[Not a regular file]`;
	}

	if (fileStat.size > MAX_UNTRACKED_FILE_BYTES) {
		return `File: ${relativePath}\n[Skipped preview: file is ${fileStat.size} bytes, larger than the ${MAX_UNTRACKED_FILE_BYTES}-byte preview limit]`;
	}

	let buffer: Buffer;
	try {
		buffer = await readFile(absolutePath);
	} catch {
		return `File: ${relativePath}\n[Unable to read file contents]`;
	}

	if (looksBinary(buffer)) {
		return `File: ${relativePath}\n[Skipped preview: binary file]`;
	}

	const content = clip(buffer.toString("utf8"), MAX_UNTRACKED_FILE_CHARS);
	return `File: ${relativePath}\n\n\`\`\`\n${content}\n\`\`\``;
}

function getHeadSha(result: GitResult): string | null {
	const value = result.stdout.trim();
	return result.code === 0 && value ? value : null;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Review git changes and commit in an isolated subagent",
		getArgumentCompletions: (prefix) => {
			const options = [{ value: "--no-verify", label: "--no-verify" }];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const repoRoot = await runGit(pi, ["rev-parse", "--show-toplevel"], ctx.cwd);
			if (repoRoot.code !== 0 || !repoRoot.stdout.trim()) {
				if (ctx.hasUI) ctx.ui.notify("The current directory is not a git repository.", "error");
				return;
			}

			const repoCwd = repoRoot.stdout.trim();
			const status = await runGit(pi, ["status", "--short"], repoCwd);
			if (status.code !== 0) {
				if (ctx.hasUI) ctx.ui.notify("Unable to read git status.", "error");
				return;
			}

			if (!status.stdout.trim()) {
				if (ctx.hasUI) ctx.ui.notify("There are no uncommitted changes.", "info");
				return;
			}

			const headBefore = getHeadSha(await runGit(pi, ["rev-parse", "--verify", "HEAD"], repoCwd));
			const noVerify = hasFlag(args, "--no-verify");

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

			if (ctx.hasUI) ctx.ui.notify("Launching /commit in an isolated subagent...", "info");

			const subagentResult = await runCommitSubagent(prompt, repoCwd);
			const headAfter = getHeadSha(await runGit(pi, ["rev-parse", "--verify", "HEAD"], repoCwd));
			const createdCommit = headAfter !== null && headAfter !== headBefore;
			const summary = clipNotification(
				subagentResult.finalOutput || subagentResult.errorMessage || subagentResult.stderr || "(no output)"
			);
			const isError =
				subagentResult.exitCode !== 0 ||
				subagentResult.stopReason === "error" ||
				subagentResult.stopReason === "aborted";

			if (!ctx.hasUI) {
				return;
			}

			if (isError) {
				ctx.ui.notify(summary ? `Commit subagent failed: ${summary}` : "Commit subagent failed.", "error");
				return;
			}

			if (createdCommit) {
				ctx.ui.notify(
					summary
						? `Created commit ${headAfter.slice(0, 7)}. ${summary}`
						: `Created commit ${headAfter.slice(0, 7)}.`,
					"success",
				);
				return;
			}

			ctx.ui.notify(
				summary
					? `Commit subagent finished without creating a commit. ${summary}`
					: "Commit subagent finished without creating a commit.",
				"info",
			);
		},
	});

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command?.trim() ?? "";

		if (matchesGitPushCommand(command)) {
			return {
				block: true,
				reason: "git push is disabled by the commit extension.",
			};
		}

		if (matchesGitCommitCommand(command)) {
			return;
		}
	});
}
