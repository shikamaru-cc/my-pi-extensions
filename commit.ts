import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

type GitResult = {
	stdout: string;
	stderr: string;
	code: number;
};

const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_CHARS = 16_000;
const MAX_UNTRACKED_FILES = 5;
const MAX_UNTRACKED_FILE_BYTES = 64_000;
const MAX_UNTRACKED_FILE_CHARS = 4_000;

async function runGit(pi: ExtensionAPI, args: string[]): Promise<GitResult> {
	const result = await pi.exec("git", args, { timeout: GIT_TIMEOUT_MS });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.code ?? 1,
	};
}

function clip(text: string, maxChars = MAX_DIFF_CHARS): string {
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
	return output
		.split("\0")
		.map((value) => value.trim())
		.filter(Boolean);
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

			const [branch, recentLog, stagedStat, unstagedStat, stagedDiff, unstagedDiff, untrackedFilesResult] = await Promise.all([
				runGit(pi, ["branch", "--show-current"]),
				runGit(pi, ["log", "--oneline", "-10"]),
				runGit(pi, ["diff", "--cached", "--stat"]),
				runGit(pi, ["diff", "--stat"]),
				runGit(pi, ["diff", "--cached"]),
				runGit(pi, ["diff"]),
				runGit(pi, ["ls-files", "--others", "--exclude-standard", "-z"]),
			]);

			const untrackedFiles = untrackedFilesResult.code === 0 ? parseNullSeparated(untrackedFilesResult.stdout) : [];
			const previewTargets = untrackedFiles.slice(0, MAX_UNTRACKED_FILES);
			const untrackedPreviews = await Promise.all(previewTargets.map((file) => buildUntrackedPreview(ctx.cwd, file)));
			const omittedUntrackedCount = Math.max(0, untrackedFiles.length - previewTargets.length);

			const prompt = `You are running the /commit workflow in pi.

Goals:
1. Review the current git changes.
2. Decide whether the work should be split into multiple commits.
3. If nothing is staged, stage the files that belong in the recommended commit.
4. When the changes are suitable for a single focused commit, write a commit message that matches the repository's recent style and run git commit.
5. Do not push.
6. If you need more context, inspect the changed files before committing.
7. After committing, report what you staged and the final commit message.

Rules:
- Prefer a single focused commit when appropriate.
- If the changes mix unrelated concerns, explain how to split them and stop without committing.
- Stage only the files that belong in the recommended commit.
- If the repository has no commit history, treat this as an initial commit.
- If you commit, ${noVerify ? "you may use git commit --no-verify." : "use a normal git commit without --no-verify unless the user explicitly asks for it."}
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

Staged diff:
${clip(stagedDiff.stdout.trim() || "(empty)")}

Unstaged diff:
${clip(unstagedDiff.stdout.trim() || "(empty)")}

Untracked files:
${untrackedFiles.length > 0 ? untrackedFiles.join("\n") : "(none)"}

Untracked file previews:
${untrackedPreviews.length > 0 ? untrackedPreviews.join("\n\n") : "(none)"}${omittedUntrackedCount > 0 ? `\n\n[${omittedUntrackedCount} additional untracked file(s) omitted from preview]` : ""}`;

			if (ctx.hasUI) ctx.ui.notify("Collected git context for /commit.", "info");
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
