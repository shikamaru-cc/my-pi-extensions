import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

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

const GIT_TIMEOUT_MS = 30_000;
const MAX_INLINE_DIFF_CHARS = 16_000;
const MAX_INLINE_DIFF_FILES = 3;
const MAX_INLINE_DIFF_LINES = 150;
const MAX_UNTRACKED_FILES = 5;
const MAX_UNTRACKED_FILE_BYTES = 64_000;
const MAX_UNTRACKED_FILE_CHARS = 4_000;

async function runGit(pi: ExtensionAPI, args: string[]): Promise<GitResult> {
	try {
		const result = await pi.exec("git", args, { timeout: GIT_TIMEOUT_MS });
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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Review git changes and commit when appropriate",
		getArgumentCompletions: (prefix) => {
			const options = [{ value: "--no-verify", label: "--no-verify" }];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const status = await runGit(pi, ["status", "--short"]);
			if (status.code !== 0) {
				if (ctx.hasUI) ctx.ui.notify("The current directory is not a git repository.", "error");
				return;
			}

			if (!status.stdout.trim()) {
				if (ctx.hasUI) ctx.ui.notify("There are no uncommitted changes.", "info");
				return;
			}

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
				runGit(pi, ["branch", "--show-current"]),
				runGit(pi, ["log", "--oneline", "-10"]),
				runGit(pi, ["diff", "--cached", "--stat"]),
				runGit(pi, ["diff", "--stat"]),
				runGit(pi, ["diff", "--cached", "--name-only", "-z"]),
				runGit(pi, ["diff", "--name-only", "-z"]),
				runGit(pi, ["diff", "--cached", "--numstat"]),
				runGit(pi, ["diff", "--numstat"]),
				runGit(pi, ["ls-files", "--others", "--exclude-standard", "-z"]),
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
					runGit(pi, ["diff", "--cached"]),
					runGit(pi, ["diff"]),
				]);
				stagedDiffText = clip(stagedDiff.stdout.trim() || "(empty)");
				unstagedDiffText = clip(unstagedDiff.stdout.trim() || "(empty)");
			}

			const previewTargets = untrackedFiles.slice(0, MAX_UNTRACKED_FILES);
			const untrackedPreviews = await Promise.all(previewTargets.map((file) => buildUntrackedPreview(ctx.cwd, file)));
			const omittedUntrackedCount = Math.max(0, untrackedFiles.length - previewTargets.length);

			const prompt = `You are running the /commit workflow in pi.

Goals:
1. Review the current git changes.
2. Decide whether the work should be split into multiple commits.
3. Use the summary below first. Run git diff or inspect changed files only when you need more detail.
4. If nothing is staged, stage the files that belong in the recommended commit.
5. When the changes are suitable for a single focused commit, write a commit message that matches the repository's recent style and run git commit.
6. Do not push.
7. After committing, report what you staged and the final commit message.

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

Git context:

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

			if (ctx.hasUI) ctx.ui.notify("Collected summarized git context for /commit.", "info");
			pi.sendUserMessage(prompt);
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
