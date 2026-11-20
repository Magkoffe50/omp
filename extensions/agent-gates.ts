/**
 * Gates: make the agent follow the review rule. This is a compliance nudge for a cooperating
 * model, not a sandbox: it matches what the model asks the tools to run and can be evaded by a
 * determined one (variable tricks, scripts that commit internally).
 *
 * 1. Commit/push gate (blocking). Gated calls:
 *    - `bash` whose command chain runs `git commit`, `git push` or a git alias expanding to one
 *      of them (aliases are read from `git config` at load). Every segment of the chain is
 *      checked (`git push && git commit` needs a pass for the commit); quoted text and heredoc
 *      bodies are ignored, `sh|bash|zsh -c "<inner>"` bodies are scanned, wrappers (`timeout N`,
 *      `sudo`, `xargs`, `if`, `!`, `{`, env assignments, `/path/to/git`) are allowed before `git`;
 *      `commit-tree` and `push --dry-run`/`-n` are not gated.
 *    - `eval` whose code passes such a command to a shell runner (`sh\`…\``, `$\`…\``,
 *      `subprocess.*`, `os.system`, `Bun.spawn`, `exec*`/`spawn*`, `tool.bash`), uses an argv
 *      array `["git", "commit"]`, or lands a draft from the `commit` namespace: `commit.commit(…)`
 *      or `<v>.commit(…)` / `<v>["commit"](…)` where `<v>` was assigned from `commit.draft(` in
 *      this or any earlier eval call of the session. `commit.draft()` alone is a preview.
 *    A call passes when every gated operation in it is allowed:
 *    - a push passes on its own when it runs in the repo of the last gated commit of this session
 *      and every pushed ref (default HEAD) resolves to that commit's HEAD;
 *    - otherwise the call needs a pass: a `task` item with `agent: "critic"` spawned from this
 *      session finished with status `completed` (host `task:subagent:lifecycle` bus event matched
 *      to a `task`/`eval` tool-call id of this session, never the model's claims), or a user
 *      waiver (below).
 *    The repo of an operation is the bash call's `cwd`, then a leading `cd X` in the chain, then
 *    `-C dir`; an unresolvable directory never matches a reviewed commit. A pass is consumed in
 *    `tool_result` when the call succeeded and, for commits, only when HEAD actually moved (a hook
 *    failure hidden behind a pipe keeps it); the new HEAD then becomes the reviewed commit. The
 *    pass is not bound to a specific diff: any completed critic unlocks the next commit.
 *    Without a pass the call is blocked with a reason telling the agent to run `critic`. No
 *    dialog is shown and the agent is never told to ask the user.
 *    User waiver: the latest user-authored message of the session — a `message` entry with
 *    `role: "user"` and `attribution: "user"` in `ctx.sessionManager.getBranch()`, written by the
 *    host (task prompts, peer/IRC and steering text relayed from agents carry
 *    `attribution: "agent"`; `before_agent_start` is not used because its `prompt` has no
 *    attribution and fires for those too) — containing a skip phrase (`SKIP_REVIEW`: «без ревью»,
 *    «без critic», "no review", "skip review", …) unlocks one gated call. It is consumed like a
 *    critic pass and never re-armed by the same message, so the next user message without the
 *    phrase restores the rule.
 *    Inside subagents the gate only blocks: subagents do not commit. Any internal error in the
 *    gate blocks (fail-closed).
 * 2. Reminder (non-blocking `additionalContext`, main session only, once per session): a second
 *    `read`/`grep` under `node_modules/` before a `researcher` subagent ran this session (one
 *    exact lookup is fine). Errors here are swallowed (fail-open).
 * All state is per session and reset on session start/switch/clear/branch/tree.
 * Known gaps (not resolved, treated as the surrounding directory): `pushd`, `GIT_DIR`/`--git-dir`/
 * `--work-tree`, and a `cd` inside a `sh -c` body relative to a `cd` outside it. The waiver trusts
 * the host's attribution: an extension calling `pi.sendUserMessage` without `attribution: "agent"`
 * counts as the user; a skip phrase is matched literally, so a negated one («не без ревью») also
 * waives, and the waiver covers one commit or push per message, not a whole batch.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const CRITIC_AGENT = "critic";
export const RESEARCHER_AGENT = "researcher";

/** User wording that waives the review: Russian «без ревью/critic/критика», English no/skip/without review/critic. */
export const SKIP_REVIEW = /без\s+(?:ревью|critic|критик\w*)|\b(?:no|skip|without)\s+(?:the\s+|a\s+)?(?:review|critic)\b/iu;

export type GitVerb = "commit" | "push";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HEREDOC = /<<-?\s*(["']?)(\w+)\1([^\n]*)\n[\s\S]*?\n\t*\2(?=\n|$)/g;
const QUOTED = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
const SHELL_C = /(?:^|[\s;&|(`])(?:\S*\/)?(?:sh|bash|zsh|dash)\s+(?:-\S+\s+)*-[A-Za-z]*c\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g;
const SEGMENT_SPLIT = /\s*(?:\|\||&&|;|\||&|\n|\$\(|\(|`)\s*/;
const COMMAND_PREFIX =
	/^(?:(?:\w+=\S*|sudo|command|exec|env|nohup|time|nice|xargs|if|then|else|elif|do|while|until|!|\{|timeout(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+\d+\S*)\s+)*/;
const PUSH_DRY_RUN = /(?:^|\s)(?:--dry-run|-n)(?=\s|$)/;
/** Push options that take a separate value, so the value is not a remote or refspec. */
const PUSH_VALUE_OPTIONS = /^(?:-o|--push-option|--receive-pack|--exec|--repo)$/;
/** Push forms that send more than named refs, so no reviewed commit can vouch for them. */
const PUSH_BULK_OPTIONS = /^(?:--all|--branches|--mirror|--tags|--delete|-d)$/;
const EVAL_ARGV = /[[(]\s*(["'])git\1\s*,\s*(["'])(commit|push)\2/;
/** Call sites whose string arguments are shell commands (bare names only when not a method of something else). */
const SHELL_RUNNER =
	/(?:(?<![\w$.])(?:sh|\$|exec(?:Sync|File|FileSync)?|spawn(?:Sync)?)|\b(?:Bun\.\$|Bun\.spawn(?:Sync)?|subprocess\.\w+|os\.(?:system|popen)|child_process\.\w+|tool\.bash))\s*(?=[(`])/g;
const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
const DRAFT_ASSIGN = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?commit\s*\.\s*draft\s*\(/g;
const EVAL_COMMIT_NS = /\bcommit\s*\.\s*commit\s*\(|commit\s*\.\s*draft\s*\([^)]*\)\s*\)?\s*\.\s*commit\s*\(/;
const NODE_MODULES = /(?:^|[\\/])node_modules[\\/]/;

interface ToolCallEvent {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

interface ToolResultEvent extends ToolCallEvent {
	content: unknown;
	details?: unknown;
	isError: boolean;
}

interface AgentInfo {
	kind: "main" | "sub";
	id: string;
	name: string;
}

/** Persisted session entry (fields the waiver reads); see `ctx.sessionManager.getBranch()`. */
interface BranchEntry {
	type?: string;
	id?: string;
	message?: { role?: string; attribution?: string; content?: unknown };
}

interface GateContext {
	agent?: AgentInfo;
	cwd: string;
	sessionManager?: { getBranch(): Iterable<BranchEntry> };
}

/** Payload of the host's `task:subagent:lifecycle` bus event (fields this guard reads). */
interface SubagentLifecycle {
	id?: string;
	agent?: string;
	parentToolCallId?: string;
	status?: string;
}

interface ToolCallResult {
	block?: boolean;
	reason?: string;
	additionalContext?: string;
}

interface ExecResult {
	stdout: string;
	code: number;
}

type ResetEvent = "session_start" | "session_switch" | "session_clear" | "session_branch" | "session_tree";

interface GateApi {
	cwd?: string;
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: GateContext) => Promise<ToolCallResult | undefined>): void;
	on(event: "tool_result", handler: (event: ToolResultEvent, ctx: GateContext) => Promise<undefined>): void;
	on(event: ResetEvent, handler: () => Promise<undefined>): void;
	events?: { on(name: "task:subagent:lifecycle", handler: (payload: SubagentLifecycle) => void): unknown };
	exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResult>;
	logger?: {
		info?: (message: string, details?: Record<string, unknown>) => void;
		warn?: (message: string, details?: Record<string, unknown>) => void;
	};
}

/** A commit/push the call performs. */
export interface GatedOperation {
	label: string;
	verb: GitVerb;
	/** Directory git runs in: `cwd`/`cd`/`-C` resolved; `null` when the command computes it. */
	dir: string | null;
	/** Refs a push sends (`HEAD` when the command names none); `null` when it sends an unknowable set. */
	refs: string[] | null;
}

/** What a repo looked like: its toplevel and the commit(s) of interest. */
interface RepoState {
	toplevel: string;
	head: string;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const expandHome = (path: string): string => (path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path);

/** Verb names (`commit`, `push`, aliases) → the git verb they run. */
export type VerbMap = Map<string, GitVerb>;

export const BASE_VERBS: VerbMap = new Map([
	["commit", "commit"],
	["push", "push"],
]);

/** Refs a `git push` sends (`HEAD` when it names none), or `null` when the set cannot be known. */
const pushRefs = (rest: string): string[] | null => {
	const words = rest.trim().split(/\s+/).filter((word) => word.length > 0);
	const positional: string[] = [];
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i];
		if (word.startsWith("-")) {
			if (PUSH_BULK_OPTIONS.test(word)) return null;
			if (PUSH_VALUE_OPTIONS.test(word)) i += 1;
			continue;
		}
		positional.push(word);
	}
	const refs: string[] = [];
	for (const spec of positional.slice(1)) {
		const src = spec.replace(/^\+/, "").split(":")[0];
		if (src.length === 0 || src === "_q_") return null;
		refs.push(src);
	}
	return refs.length > 0 ? refs : ["HEAD"];
};

/**
 * Every `git commit`/`git push` (or alias) at command position in a shell command, in order.
 * `base` is the directory the command starts in; `null` when unknown.
 */
export const gitWritesInCommand = (command: string, verbs: VerbMap = BASE_VERBS, base: string | null = null): GatedOperation[] => {
	const names = [...verbs.keys()].map(escapeRegExp).join("|");
	const verbAt = new RegExp(`^(?:\\S*/)?git((?:\\s+--?[\\w-]+(?:[= ]\\S+)?)*)\\s+(${names})(?![\\w-])(.*)$`);
	const found: GatedOperation[] = [];
	for (const match of command.matchAll(SHELL_C)) {
		const inner = match[1] !== undefined ? match[1].replace(/\\(["\\$`])/g, "$1") : (match[2] ?? "");
		found.push(...gitWritesInCommand(inner, verbs, base));
	}
	const stripped = command
		.replace(HEREDOC, (_m, _q, delim: string, rest: string) => `<<${delim}${rest}`)
		.replace(QUOTED, (_m, double: string | undefined, single: string | undefined) => {
			const inner = double ?? single ?? "";
			return verbs.has(inner) ? inner : "_q_";
		});
	let dir = base;
	for (const rawSegment of stripped.split(SEGMENT_SPLIT)) {
		const segment = rawSegment.trim().replace(COMMAND_PREFIX, "");
		const cd = /^cd(?:\s+(\S+))?\s*$/.exec(segment);
		if (cd) {
			const target = cd[1];
			if (target === undefined) dir = homedir();
			else if (target === "_q_" || target === "-" || target.includes("$")) dir = null;
			else dir = dir === null ? null : resolve(dir, expandHome(target));
			continue;
		}
		const match = verbAt.exec(segment);
		if (!match) continue;
		const [, options, name, rest] = match;
		const verb = verbs.get(name);
		if (verb === undefined) continue;
		if (verb === "push" && PUSH_DRY_RUN.test(rest)) continue;
		const dirMatch = /(?:^|\s)-C\s+(\S+)/.exec(options);
		let opDir = dir;
		if (dirMatch) {
			const target = dirMatch[1];
			opDir = target === "_q_" || target.includes("$") ? null : dir === null && !isAbsolute(expandHome(target)) ? null : resolve(dir ?? "/", expandHome(target));
		}
		found.push({
			label: `git ${verb}${name === verb ? "" : ` (alias ${name})`}`,
			verb,
			dir: opDir,
			refs: verb === "push" ? pushRefs(rest) : [],
		});
	}
	return found;
};

/** Variable names assigned from `commit.draft(` in an eval code string. */
export const draftNamesIn = (code: string): string[] => [...code.matchAll(DRAFT_ASSIGN)].map((match) => match[1]);

/** Names in `candidates` the code assigns something other than a `commit.draft(` to. */
export const reassignedNames = (code: string, candidates: Iterable<string>): string[] => {
	const gone: string[] = [];
	for (const name of candidates) {
		const assigned = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*=(?!=)\\s*(?:await\\s+)?(commit\\s*\\.\\s*draft\\s*\\()?`, "g");
		for (const match of code.matchAll(assigned)) {
			if (match[1] === undefined) {
				gone.push(name);
				break;
			}
		}
	}
	return gone;
};

/**
 * Commit/push operations an `eval` code string performs: shell commands handed to a runner,
 * argv arrays, or the `commit` namespace (`draftNames`: variables holding a `commit.draft()`).
 */
export const gitWritesInEval = (code: string, verbs: VerbMap = BASE_VERBS, draftNames: Iterable<string> = [], cwd: string | null = null): GatedOperation[] => {
	const found: GatedOperation[] = [];
	const argv = EVAL_ARGV.exec(code);
	if (argv) found.push({ label: `git ${argv[3]} (argv)`, verb: argv[3] as GitVerb, dir: cwd, refs: argv[3] === "push" ? ["HEAD"] : [] });
	for (const runner of code.matchAll(SHELL_RUNNER)) {
		const start = runner.index + runner[0].length;
		const open = code[start];
		let argument: string;
		if (open === "`") {
			const close = code.indexOf("`", start + 1);
			argument = code.slice(start, close === -1 ? undefined : close + 1);
		} else {
			let depth = 0;
			let end = start;
			for (; end < code.length; end += 1) {
				if (code[end] === "(") depth += 1;
				else if (code[end] === ")") {
					depth -= 1;
					if (depth === 0) break;
				}
			}
			argument = code.slice(start, end);
		}
		for (const literal of argument.matchAll(STRING_LITERAL)) {
			const inner = literal[1] ?? literal[2] ?? literal[3] ?? "";
			found.push(...gitWritesInCommand(inner, verbs, cwd).map((op) => ({ ...op, label: `${op.label} (eval)` })));
		}
	}
	if (EVAL_COMMIT_NS.test(code)) found.push({ label: "commit namespace", verb: "commit", dir: cwd, refs: [] });
	const names = new Set([...draftNames, ...draftNamesIn(code)]);
	for (const name of names) {
		const escaped = escapeRegExp(name);
		if (new RegExp(`\\b${escaped}\\s*(?:\\.\\s*commit\\s*\\(|\\[\\s*["']commit["']\\s*\\]\\s*\\()`).test(code)) {
			found.push({ label: `${name}.commit() on a commit.draft()`, verb: "commit", dir: cwd, refs: [] });
		}
	}
	return found;
};

/** Git aliases that run commit/push, from `git config --get-regexp ^alias\.` output lines. */
export const aliasVerbs = (configLines: string): VerbMap => {
	const verbs: VerbMap = new Map(BASE_VERBS);
	for (const line of configLines.split("\n")) {
		const match = /^alias\.(\S+)\s+(.*)$/.exec(line.trim());
		if (!match) continue;
		const [, alias, expansion] = match;
		const first = /^(\S+)/.exec(expansion)?.[1];
		if (first !== undefined && BASE_VERBS.has(first)) verbs.set(alias, BASE_VERBS.get(first) as GitVerb);
		else if (expansion.startsWith("!")) {
			const shell = gitWritesInCommand(expansion.slice(1), BASE_VERBS)[0];
			if (shell) verbs.set(alias, shell.verb);
		}
	}
	return verbs;
};

/** Agent types requested by a `task` call: batch `tasks[].agent` or flat `agent`. */
export const taskAgents = (input: Record<string, unknown>): string[] => {
	const agents: string[] = [];
	const tasks = input.tasks;
	if (Array.isArray(tasks)) {
		for (const item of tasks) {
			if (item !== null && typeof item === "object") agents.push(str((item as Record<string, unknown>).agent));
		}
	}
	if (typeof input.agent === "string") agents.push(input.agent);
	return agents.filter((name) => name.length > 0);
};

/** Text of a persisted message: a string, or its text blocks joined. */
const messageText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: unknown) => (block !== null && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
		.join("\n");
};

/** Id of the latest user-authored message when its text waives the review; `undefined` otherwise. */
export const userWaiverIn = (entries: Iterable<BranchEntry>): string | undefined => {
	let latest: BranchEntry | undefined;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "user" && entry.message.attribution === "user") latest = entry;
	}
	if (latest === undefined || typeof latest.id !== "string") return undefined;
	return SKIP_REVIEW.test(messageText(latest.message?.content)) ? latest.id : undefined;
};

/** Paths a `read`/`grep` call targets, `~` expanded. */
const targetPaths = (event: ToolCallEvent): string[] =>
	str(event.input.path)
		.split(";")
		.map((part) => expandHome(part.trim()))
		.filter((part) => part.length > 0 && !part.startsWith("!"));

export const touchesNodeModules = (event: ToolCallEvent): boolean =>
	(event.toolName === "read" || event.toolName === "grep") && targetPaths(event).some((path) => NODE_MODULES.test(path));

const RECOVERY =
	`Rule: commit/push requires a finished \`${CRITIC_AGENT}\` review (cross-model code review) in this session, and none has completed since the last commit/push. ` +
	`Dispatch \`task\` with an item {agent: "${CRITIC_AGENT}"} that reviews the diff, wait for it to finish, address blocking findings, then retry. ` +
	`Do not ask the user to skip the review.`;

type Pass = "critic" | "override" | "head";

export default async function agentGates(pi: GateApi): Promise<void> {
	/** Session-scoped state: the factory is bound once per session, subagents included. */
	let criticPassed = false;
	/** Id of the user message whose waiver has already been spent. */
	let waiverUsed: string | undefined;
	/** Repo and HEAD of the last gated commit that landed in this session. */
	let reviewed: RepoState | undefined;
	let researcherRan = false;
	let researcherReminded = false;
	let nodeModulesLookups = 0;
	/** Ids of `task`/`eval` calls made by this session; lifecycle events are matched against them. */
	const spawnCallIds = new Set<string>();
	/** Eval variables holding a `commit.draft()`, across eval calls. */
	const draftNames = new Set<string>();
	/** Gated calls allowed and still running: what let them through and the repos before the call. */
	const pending = new Map<string, { pass: Pass; waiver?: string; operations: GatedOperation[]; before: (RepoState | undefined)[] }>();

	let verbs: VerbMap = BASE_VERBS;
	try {
		const aliases = await pi.exec("git", ["config", "--get-regexp", "^alias\\."], { cwd: pi.cwd, timeout: 5000 });
		if (aliases.code === 0) verbs = aliasVerbs(aliases.stdout);
	} catch (error) {
		pi.logger?.warn?.("agent-gates: git alias lookup failed", { error: error instanceof Error ? error.message : String(error) });
	}

	const reset = async (): Promise<undefined> => {
		criticPassed = false;
		waiverUsed = undefined;
		reviewed = undefined;
		researcherRan = false;
		researcherReminded = false;
		nodeModulesLookups = 0;
		spawnCallIds.clear();
		draftNames.clear();
		pending.clear();
		return undefined;
	};
	for (const event of ["session_start", "session_switch", "session_clear", "session_branch", "session_tree"] as const) pi.on(event, reset);

	pi.events?.on("task:subagent:lifecycle", (payload) => {
		if (payload.status !== "completed" || payload.agent !== CRITIC_AGENT) return;
		if (payload.parentToolCallId === undefined || !spawnCallIds.has(payload.parentToolCallId)) return;
		criticPassed = true;
		pi.logger?.info?.("agent-gates: critic review completed", { id: payload.id });
	});

	/** Toplevel and HEAD of the repo at `dir`, plus the commits `refs` resolve to; `undefined` when git cannot answer. */
	const repoState = async (dir: string | null, refs: string[] = []): Promise<(RepoState & { refs: string[] }) | undefined> => {
		if (dir === null) return undefined;
		try {
			const result = await pi.exec("git", ["rev-parse", "--show-toplevel", "HEAD", ...refs], { cwd: dir, timeout: 5000 });
			const lines = result.stdout.trim().split("\n");
			if (result.code !== 0 || lines.length !== 2 + refs.length) return undefined;
			return { toplevel: lines[0], head: lines[1], refs: lines.slice(2) };
		} catch {
			return undefined;
		}
	};

	const operationsOf = (event: ToolCallEvent, ctx: GateContext): GatedOperation[] => {
		if (event.toolName === "bash") {
			const cwd = str(event.input.cwd);
			const base = cwd.length > 0 ? resolve(ctx.cwd, expandHome(cwd)) : ctx.cwd;
			return gitWritesInCommand(str(event.input.command), verbs, base).map((op) => ({ ...op, label: `bash: ${op.label}` }));
		}
		if (event.toolName === "eval") {
			const code = str(event.input.code);
			const ops = gitWritesInEval(code, verbs, draftNames, ctx.cwd).map((op) => ({ ...op, label: `eval: ${op.label}` }));
			for (const name of reassignedNames(code, draftNames)) draftNames.delete(name);
			for (const name of draftNamesIn(code)) draftNames.add(name);
			return ops;
		}
		return [];
	};

	/** True when the push sends only the reviewed commit from the reviewed repo. */
	const pushesReviewed = async (operation: GatedOperation): Promise<boolean> => {
		const target = reviewed;
		if (target === undefined || operation.verb !== "push") return false;
		if (operation.refs === null) return false;
		const state = await repoState(operation.dir, operation.refs);
		return state !== undefined && state.toplevel === target.toplevel && state.refs.every((sha) => sha === target.head);
	};

	const gate = async (event: ToolCallEvent, ctx: GateContext): Promise<ToolCallResult | undefined> => {
		const operations = operationsOf(event, ctx);
		if (operations.length === 0) return undefined;
		const label = operations.map((op) => op.label).join(", ");
		if (ctx.agent !== undefined && ctx.agent.kind !== "main") {
			return {
				block: true,
				reason: `agent-gates: blocked \`${label}\` in subagent \`${ctx.agent.id}\`: subagents do not commit or push; report what should be committed and leave it to the main agent.`,
			};
		}
		const allow = async (pass: Pass, waiver?: string): Promise<undefined> => {
			const before = await Promise.all(operations.map((op) => (op.verb === "commit" ? repoState(op.dir) : Promise.resolve(undefined))));
			pending.set(event.toolCallId, { pass, waiver, operations, before });
			pi.logger?.info?.("agent-gates: allowed", { operations: label, pass });
			return undefined;
		};
		let needsPass = false;
		for (const op of operations) if (!(await pushesReviewed(op))) needsPass = true;
		if (!needsPass) return allow("head");
		if (criticPassed) return allow("critic");
		const waiver = ctx.sessionManager === undefined ? undefined : userWaiverIn(ctx.sessionManager.getBranch());
		if (waiver !== undefined && waiver !== waiverUsed) return allow("override", waiver);
		pi.logger?.info?.("agent-gates: blocked", { operations: label });
		return { block: true, reason: `agent-gates: blocked \`${label}\`. ${RECOVERY}` };
	};

	/** Consume the pass of a finished gated call when it did its work; record the commit it landed. */
	const settle = async (event: ToolResultEvent): Promise<void> => {
		const entry = pending.get(event.toolCallId);
		if (entry === undefined) return;
		pending.delete(event.toolCallId);
		if (event.isError) return;
		let landed = false;
		for (const [index, op] of entry.operations.entries()) {
			if (op.verb !== "commit") continue;
			const after = await repoState(op.dir);
			const before = entry.before[index];
			if (after !== undefined && before !== undefined && after.head === before.head) continue;
			landed = true;
			if (after !== undefined) reviewed = { toplevel: after.toplevel, head: after.head };
			pi.logger?.info?.("agent-gates: commit landed", { head: after?.head });
		}
		const consume = landed || entry.operations.some((op) => op.verb === "push");
		if (!consume) return;
		if (entry.pass === "critic") criticPassed = false;
		if (entry.pass === "override") waiverUsed = entry.waiver;
	};

	const remind = (event: ToolCallEvent, ctx: GateContext): string | undefined => {
		if (ctx.agent !== undefined && ctx.agent.kind !== "main") return undefined;
		if (researcherRan || researcherReminded || !touchesNodeModules(event)) return undefined;
		nodeModulesLookups += 1;
		if (nodeModulesLookups < 2) return undefined;
		researcherReminded = true;
		return `agent-gates reminder: this is your second lookup under node_modules/ while no \`${RESEARCHER_AGENT}\` subagent has run this session. One exact-string lookup is fine; for anything beyond that dispatch \`task\` with an item {agent: "${RESEARCHER_AGENT}"} instead of reading node_modules yourself.`;
	};

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "task" || event.toolName === "eval") spawnCallIds.add(event.toolCallId);
		let result: ToolCallResult | undefined;
		try {
			result = await gate(event, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { block: true, reason: `agent-gates: gate failed (${message}); blocked to be safe. ${RECOVERY}` };
		}
		if (result !== undefined) return result;
		try {
			const additionalContext = remind(event, ctx);
			return additionalContext === undefined ? undefined : { additionalContext };
		} catch (error) {
			pi.logger?.warn?.("agent-gates: reminder failed", { error: error instanceof Error ? error.message : String(error) });
			return undefined;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			await settle(event);
			if (event.toolName === "task" && !event.isError && (ctx.agent === undefined || ctx.agent.kind === "main")) {
				if (taskAgents(event.input).includes(RESEARCHER_AGENT)) researcherRan = true;
			}
		} catch (error) {
			pi.logger?.warn?.("agent-gates: result handling failed", { error: error instanceof Error ? error.message : String(error) });
		}
		return undefined;
	});
}
