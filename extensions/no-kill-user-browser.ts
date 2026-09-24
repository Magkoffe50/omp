/**
 * Guard: never let the `browser` tool spawn (and therefore kill) the user's own browser.
 *
 * Why this exists: with `app.path` the browser tool resolves kind=spawned, and when the
 * running instance has no CDP port the harness runs `killExistingByPath()` first
 * ("Killed existing instances before attach"). Pointing that at
 * /Applications/Google Chrome.app terminates the user's live Chrome session.
 *
 * This extension revises such `browser` tool calls before execution:
 *   - user-facing Chromium-family binary       -> isolated Chrome for Testing + dedicated profile
 *   - `--user-data-dir` on a real user profile -> dedicated profile dir
 *   - no Chrome for Testing available          -> drop `app` (falls back to relay/headless)
 * Anything else (Electron dev builds, omp-managed binaries) is left untouched.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const HOME = homedir();
const OMP_DIR = join(HOME, ".omp");
const SPAWN_PROFILE_DIR = join(OMP_DIR, "chrome-spawn-profile");

/** Bundle/binary names that belong to a browser a human keeps open with real sessions. */
const USER_BROWSER_NAMES: Record<string, true> = {
	"google chrome": true,
	"google chrome canary": true,
	"google chrome beta": true,
	"google chrome dev": true,
	chromium: true,
	"brave browser": true,
	"brave browser beta": true,
	"brave browser nightly": true,
	"microsoft edge": true,
	"microsoft edge beta": true,
	"microsoft edge dev": true,
	"microsoft edge canary": true,
	arc: true,
	dia: true,
	comet: true,
	vivaldi: true,
	opera: true,
	"opera gx": true,
	yandex: true,
	thorium: true,
	orion: true,
	zen: true,
	firefox: true,
	"firefox developer edition": true,
	safari: true,
};

/** Profile roots that hold the user's own browser data. */
const USER_PROFILE_ROOTS = [
	join(HOME, "Library/Application Support/Google/Chrome"),
	join(HOME, "Library/Application Support/Chromium"),
	join(HOME, "Library/Application Support/BraveSoftware"),
	join(HOME, "Library/Application Support/Microsoft Edge"),
	join(HOME, "Library/Application Support/Vivaldi"),
	join(HOME, "Library/Application Support/com.operasoftware.Opera"),
	join(HOME, ".config/google-chrome"),
	join(HOME, ".config/chromium"),
	join(HOME, ".config/BraveSoftware"),
	join(HOME, ".config/microsoft-edge"),
];

/** True when spawning (and pre-emptively killing) this executable would hit a browser the user is using. */
export const isUserBrowserPath = (execPath: string | undefined): boolean => {
	if (!execPath) return false;
	const full = execPath.startsWith("~/") ? join(HOME, execPath.slice(2)) : execPath;
	// omp-managed binaries (Chrome for Testing, puppeteer downloads) are ours to spawn and kill.
	if (full.includes(`${OMP_DIR}/`) || /for testing/i.test(full)) return false;

	// macOS `.../Foo.app/Contents/MacOS/bar` identifies as "foo"; elsewhere the binary name is the identity.
	const parts = full.split("/");
	const macOsIdx = parts.lastIndexOf("MacOS");
	const bundle =
		macOsIdx >= 2 && parts[macOsIdx - 1] === "Contents"
			? parts[macOsIdx - 2].replace(/\.app$/i, "").toLowerCase()
			: undefined;
	return (bundle !== undefined && USER_BROWSER_NAMES[bundle] === true) || USER_BROWSER_NAMES[basename(full).toLowerCase()] === true;
};

/** True when a `--user-data-dir=<value>` argument points into the user's real browser profile. */
export const isUserProfileDir = (value: string): boolean => {
	const full = resolve(value.startsWith("~/") ? join(HOME, value.slice(2)) : value);
	return USER_PROFILE_ROOTS.some((root) => full === root || full.startsWith(`${root}/`));
};

/** Newest downloaded Chrome for Testing binary, or an explicit non-user puppeteer override. */
export const findIsolatedChrome = (): string | undefined => {
	const override = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (override && existsSync(override) && !isUserBrowserPath(override)) return override;

	const root = join(OMP_DIR, "puppeteer", "chrome");
	if (!existsSync(root)) return undefined;

	const found: { revision: string; exe: string }[] = [];
	for (const revision of readdirSync(root)) {
		let platforms: string[];
		try {
			platforms = readdirSync(join(root, revision));
		} catch {
			continue;
		}
		for (const platform of platforms) {
			const platformDir = join(root, revision, platform);
			for (const candidate of [
				join(platformDir, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
				join(platformDir, "chrome"),
				join(platformDir, "chrome.exe"),
			]) {
				if (existsSync(candidate)) found.push({ revision, exe: candidate });
			}
		}
	}
	found.sort((a, b) => a.revision.localeCompare(b.revision, "en", { numeric: true }));
	return found.at(-1)?.exe;
};

export interface BrowserApp {
	path?: string;
	cdp_url?: string;
	relay?: boolean;
	args?: string[];
	target?: string;
}

export interface BrowserAppRevision {
	/** Replacement `app` field; `undefined` means drop it and let kind resolution fall back. */
	app?: BrowserApp;
	reason: string;
}

/** Returns a safe replacement for `app`, or `undefined` when the call cannot harm the user's browser. */
export const reviseBrowserApp = (
	app: BrowserApp | undefined,
	isolatedChrome: string | undefined = findIsolatedChrome(),
): BrowserAppRevision | undefined => {
	if (!app?.path) return undefined;

	const args = app.args ?? [];
	const profileArgIdx = args.findIndex((arg) => arg.startsWith("--user-data-dir"));
	const profileArg = profileArgIdx >= 0 ? args[profileArgIdx] : undefined;
	const profileValue = profileArg === undefined ? "" : profileArg.slice(profileArg.indexOf("=") + 1);
	const hitsUserBrowser = isUserBrowserPath(app.path);
	const hitsUserProfile = profileValue.length > 0 && isUserProfileDir(profileValue);
	if (!hitsUserBrowser && !hitsUserProfile) return undefined;

	if (hitsUserBrowser && isolatedChrome === undefined) {
		const { path: _path, args: _args, ...rest } = app;
		return {
			app: Object.keys(rest).length > 0 ? rest : undefined,
			reason: `refused to spawn user browser ${app.path}: no Chrome for Testing available, falling back to relay/headless`,
		};
	}

	const nextArgs = hitsUserProfile ? args.filter((_, idx) => idx !== profileArgIdx) : [...args];
	if (!nextArgs.some((arg) => arg.startsWith("--user-data-dir"))) {
		nextArgs.push(`--user-data-dir=${SPAWN_PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check");
	}
	const nextPath = hitsUserBrowser && isolatedChrome !== undefined ? isolatedChrome : app.path;
	return {
		app: { ...app, path: nextPath, args: nextArgs },
		reason: hitsUserBrowser
			? `rewrote ${app.path} -> ${nextPath} with an isolated profile so the user's browser is never killed`
			: `moved --user-data-dir off the user's real profile (${profileValue}) to ${SPAWN_PROFILE_DIR}`,
	};
};

interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

interface GuardApi {
	on(
		event: "tool_call",
		handler: (event: ToolCallEvent) => Promise<{ input: Record<string, unknown> } | undefined>,
	): void;
	logger?: { info?: (message: string, details?: Record<string, unknown>) => void };
}

export default function noKillUserBrowser(pi: GuardApi): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "browser") return undefined;

		const rawApp = event.input.app;
		const app: BrowserApp | undefined =
			rawApp !== null && typeof rawApp === "object" ? (rawApp as BrowserApp) : undefined;
		const revision = reviseBrowserApp(app);
		if (revision === undefined) return undefined;

		pi.logger?.info?.("browser guard revised app spawn", { reason: revision.reason });
		const next: Record<string, unknown> = { ...event.input };
		if (revision.app === undefined) delete next.app;
		else next.app = revision.app;
		return { input: next };
	});
}
