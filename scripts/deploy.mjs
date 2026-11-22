import {
	accessSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isInsideOrEqual(parent, child) {
	const relation = relative(parent, child);
	return relation === ""
		|| (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function assertNoSymlinks(candidate) {
	const absolute = resolve(candidate);
	const root = parse(absolute).root;
	let current = root;

	for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
		current = join(current, component);
		if (!existsSync(current)) continue;
		if (lstatSync(current).isSymbolicLink()) {
			throw new Error(`Symbolic links are not allowed in deployment paths: ${current}`);
		}
	}
}

function expandEnvironment(value, environment) {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
		const replacement = environment[name];
		if (replacement === undefined) {
			throw new Error(
				`Environment variable ${name} is required by the deployment configuration.`,
			);
		}
		return replacement;
	});
}

function readStrictJson(path, description) {
	assertNoSymlinks(path);
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error(`${description} does not exist: ${path}`);
	}

	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const windowsHint = process.platform === "win32"
			? " On Windows, use forward slashes or double every backslash in paths."
			: "";
		throw new Error(`${description} is not strict JSON: ${path} (${detail}).${windowsHint}`);
	}
}

function readManifest(projectRoot) {
	const manifestPath = join(projectRoot, "manifest.json");
	const manifest = readStrictJson(manifestPath, "Plugin manifest");
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new Error("Plugin manifest must be a JSON object.");
	}
	if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) {
		throw new Error("Plugin manifest has an invalid id.");
	}
	return manifest;
}

function strictConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Deployment config must be a JSON object.");
	}

	const allowed = new Set(["$schema", "vaults", "backup"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`Unknown config property: ${key}`);
	}
	if (value.$schema !== undefined && typeof value.$schema !== "string") {
		throw new Error('Config property "$schema" must be a string.');
	}
	if (typeof value.backup !== "boolean") {
		throw new Error('Config property "backup" must be boolean.');
	}
	if (!Array.isArray(value.vaults) || value.vaults.length === 0) {
		throw new Error('Config property "vaults" must be a non-empty array.');
	}
	return value;
}

function parseVaults(config, vaultArgs, environment) {
	const configured = config
		? strictConfig(config).vaults.map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error("Each vault must be an object.");
			}

			const allowed = new Set(["name", "path", "enabled"]);
			for (const key of Object.keys(entry)) {
				if (!allowed.has(key)) throw new Error(`Unknown vault property: ${key}`);
			}
			if (typeof entry.name !== "string" || !entry.name.trim()) {
				throw new Error("Each vault requires a non-empty name.");
			}
			if (typeof entry.path !== "string" || !entry.path.trim()) {
				throw new Error("Each vault requires a non-empty path.");
			}
			if (typeof entry.enabled !== "boolean") {
				throw new Error("Each vault requires an enabled boolean.");
			}

			const name = expandEnvironment(entry.name, environment);
			const path = expandEnvironment(entry.path, environment);
			if (!name.trim() || !path.trim()) {
				throw new Error("Expanded vault names and paths must be non-empty.");
			}
			return { name, path, enabled: entry.enabled };
		})
		: [];

	const overrides = vaultArgs.map((vaultPath, index) => ({
		name: `Command-line vault ${index + 1}`,
		path: expandEnvironment(vaultPath, environment),
		enabled: true,
	}));

	return configured.concat(overrides).filter((vault) => vault.enabled);
}

function readConfig(configPath, projectRoot) {
	if (!configPath) return null;
	const absolute = isAbsolute(configPath)
		? resolve(configPath)
		: resolve(projectRoot, configPath);
	return readStrictJson(absolute, "Deployment config");
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildRelease(projectRoot) {
	const bundledNpmCli = join(
		dirname(process.execPath),
		"node_modules",
		"npm",
		"bin",
		"npm-cli.js",
	);
	const npmExecPath = process.env.npm_execpath;
	let executable = process.execPath;
	let argumentsList;

	if (npmExecPath && existsSync(npmExecPath) && /\.(?:c?js)$/.test(npmExecPath)) {
		argumentsList = [npmExecPath, "run", "build"];
	} else if (existsSync(bundledNpmCli)) {
		argumentsList = [bundledNpmCli, "run", "build"];
	} else if (process.platform !== "win32") {
		executable = "npm";
		argumentsList = ["run", "build"];
	} else {
		throw new Error("Could not resolve the npm CLI without a shell command.");
	}

	const result = spawnSync(executable, argumentsList, {
		cwd: projectRoot,
		stdio: "inherit",
		shell: false,
	});
	if (result.error) throw new Error(`Build failed: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(`Build failed with exit code ${result.status ?? "unknown"}.`);
	}
}

function preflightDestinations(vaults, pluginId, projectRoot) {
	if (vaults.length === 0) throw new Error("No enabled vaults were configured.");

	const destinations = vaults.map((vault) => {
		const vaultRoot = isAbsolute(vault.path)
			? resolve(vault.path)
			: resolve(projectRoot, vault.path);
		assertNoSymlinks(vaultRoot);
		if (!existsSync(vaultRoot) || !statSync(vaultRoot).isDirectory()) {
			throw new Error(`Vault does not exist: ${vaultRoot}`);
		}

		const configDirectory = join(vaultRoot, ".obsidian");
		assertNoSymlinks(configDirectory);
		if (!existsSync(configDirectory) || !statSync(configDirectory).isDirectory()) {
			throw new Error(
				`Path is not an Obsidian vault because .obsidian is missing: ${vaultRoot}`,
			);
		}
		accessSync(configDirectory, constants.R_OK | constants.W_OK);

		const pluginRoot = join(configDirectory, "plugins", pluginId);
		assertNoSymlinks(pluginRoot);
		const overlapsProject = isInsideOrEqual(projectRoot, pluginRoot)
			|| isInsideOrEqual(pluginRoot, projectRoot);
		if (overlapsProject) {
			throw new Error(`Unsafe deployment destination overlaps the project source: ${pluginRoot}`);
		}

		return { ...vault, vaultRoot, pluginRoot, files: [] };
	});

	for (let left = 0; left < destinations.length; left++) {
		for (let right = left + 1; right < destinations.length; right++) {
			const overlaps = isInsideOrEqual(
				destinations[left].pluginRoot,
				destinations[right].pluginRoot,
			) || isInsideOrEqual(
				destinations[right].pluginRoot,
				destinations[left].pluginRoot,
			);
			if (overlaps) {
				throw new Error(
					`Overlapping deployment destinations: ${destinations[left].pluginRoot} and ${destinations[right].pluginRoot}`,
				);
			}
		}
	}

	return destinations;
}

function createPlan(destinations, projectRoot) {
	return destinations.map((destination) => {
		const files = RELEASE_FILES.map((name) => {
			const source = join(projectRoot, name);
			if (!existsSync(source) || !statSync(source).isFile()) {
				throw new Error(`Missing release file: ${source}`);
			}
			assertNoSymlinks(source);

			const target = join(destination.pluginRoot, name);
			assertNoSymlinks(target);
			const sourceHash = sha256(source);
			const targetExists = existsSync(target);
			if (targetExists && !statSync(target).isFile()) {
				throw new Error(`Deployment target is not a regular file: ${target}`);
			}
			const targetHash = targetExists ? sha256(target) : null;

			return {
				name,
				source,
				target,
				sourceHash,
				targetHash,
				changed: sourceHash !== targetHash,
			};
		});

		return { ...destination, files };
	});
}

function removeFileIfPresent(path) {
	if (existsSync(path)) unlinkSync(path);
}

function commitPlan(plan, { backup, deploymentId, dryRun, hooks = {} }) {
	const summary = plan.map((vault) => ({
		name: vault.name,
		path: vault.vaultRoot,
		pluginPath: vault.pluginRoot,
		changed: vault.files.filter((file) => file.changed).map((file) => file.name),
		unchanged: vault.files.filter((file) => !file.changed).map((file) => file.name),
		backupPath: null,
	}));

	if (dryRun) {
		return {
			dryRun: true,
			changed: summary.some((vault) => vault.changed.length > 0),
			vaults: summary,
		};
	}

	const committed = [];
	let committedFileCount = 0;

	try {
		for (const vault of plan) {
			mkdirSync(vault.pluginRoot, { recursive: true });
			assertNoSymlinks(vault.pluginRoot);
			const changed = vault.files.filter((file) => file.changed);
			if (changed.length === 0) continue;

			const durableBackup = backup
				? join(vault.pluginRoot, ".working-tabs-backups", deploymentId)
				: null;
			const rollbackRoot = join(
				vault.pluginRoot,
				`.working-tabs-rollback-${deploymentId}`,
			);
			const summaryEntry = summary.find(
				(entry) => entry.pluginPath === vault.pluginRoot,
			);

			if (durableBackup) {
				mkdirSync(durableBackup, { recursive: true });
				summaryEntry.backupPath = durableBackup;
			}
			mkdirSync(rollbackRoot, { recursive: true });

			for (const file of changed) {
				if (hooks.beforeCommit) {
					hooks.beforeCommit({
						vault,
						file,
						index: committedFileCount,
						deploymentId,
					});
				}

				const stage = join(
					vault.pluginRoot,
					`.${file.name}.working-tabs-stage-${deploymentId}`,
				);
				copyFileSync(file.source, stage);
				let rollbackPath = join(rollbackRoot, file.name);
				if (existsSync(file.target)) {
					if (durableBackup) {
						copyFileSync(file.target, join(durableBackup, file.name));
					}
					renameSync(file.target, rollbackPath);
				} else {
					rollbackPath = null;
				}

				committed.push({ file, stage, rollbackPath, rollbackRoot });
				try {
					renameSync(stage, file.target);
					committedFileCount++;
				} catch (error) {
					removeFileIfPresent(stage);
					throw error;
				}
			}
		}
	} catch (error) {
		const failures = [];
		for (const entry of committed.reverse()) {
			try {
				removeFileIfPresent(entry.file.target);
				if (entry.rollbackPath && existsSync(entry.rollbackPath)) {
					renameSync(entry.rollbackPath, entry.file.target);
				}
				removeFileIfPresent(entry.stage);
			} catch (rollbackError) {
				failures.push(
					`${entry.file.target}: ${
						rollbackError instanceof Error
							? rollbackError.message
							: String(rollbackError)
					}`,
				);
			}
		}

		for (const vault of plan) {
			const rollbackRoot = join(
				vault.pluginRoot,
				`.working-tabs-rollback-${deploymentId}`,
			);
			if (existsSync(rollbackRoot)) {
				try {
					rmdirSync(rollbackRoot);
				} catch (cleanupError) {
					failures.push(
						`${rollbackRoot}: ${
							cleanupError instanceof Error
								? cleanupError.message
								: String(cleanupError)
						}`,
					);
				}
			}
		}

		const suffix = failures.length
			? ` Rollback also failed for: ${failures.join("; ")}`
			: " All completed writes were rolled back.";
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}${suffix}`,
		);
	}

	for (const entry of committed) {
		removeFileIfPresent(entry.stage);
		if (entry.rollbackPath) removeFileIfPresent(entry.rollbackPath);
	}
	for (const vault of plan) {
		const rollbackRoot = join(
			vault.pluginRoot,
			`.working-tabs-rollback-${deploymentId}`,
		);
		if (existsSync(rollbackRoot)) rmdirSync(rollbackRoot);
	}

	return {
		dryRun: false,
		changed: summary.some((vault) => vault.changed.length > 0),
		vaults: summary,
	};
}

export function deployRelease(options = {}) {
	const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
	assertNoSymlinks(projectRoot);
	const config = options.configPath ? readConfig(options.configPath, projectRoot) : null;
	const environment = options.environment ?? process.env;
	const vaults = parseVaults(config, options.vaults ?? [], environment);
	const backup = config?.backup ?? options.backup ?? true;
	if (typeof backup !== "boolean") throw new Error("Backup option must be boolean.");

	const manifest = readManifest(projectRoot);
	const destinations = preflightDestinations(vaults, manifest.id, projectRoot);
	if (!options.skipBuild) buildRelease(projectRoot);
	const plan = createPlan(destinations, projectRoot);
	const deploymentId = options.deploymentId ?? `deploy-${Date.now()}-${process.pid}`;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deploymentId)) {
		throw new Error("Deployment identifier is not safe.");
	}

	return commitPlan(plan, {
		backup,
		deploymentId,
		dryRun: Boolean(options.dryRun),
		hooks: options.hooks,
	});
}

export function parseArguments(argumentsList) {
	const options = {
		configPath: null,
		vaults: [],
		dryRun: false,
		skipBuild: false,
	};

	for (let index = 0; index < argumentsList.length; index++) {
		const argument = argumentsList[index];
		if (argument === "--dry-run") options.dryRun = true;
		else if (argument === "--skip-build") options.skipBuild = true;
		else if (argument === "--config") {
			const value = argumentsList[++index];
			if (!value) throw new Error("--config requires a path.");
			options.configPath = value;
		} else if (argument === "--vault") {
			const value = argumentsList[++index];
			if (!value) throw new Error("--vault requires a path.");
			options.vaults.push(value);
		} else if (argument === "--help" || argument === "-h") options.help = true;
		else throw new Error(`Unknown argument: ${argument}`);
	}

	return options;
}

function usage() {
	console.log(
		"Usage: node scripts/deploy.mjs [--config path] [--vault path ...] [--dry-run] [--skip-build]",
	);
}

function obsidianCliPath() {
	const candidates = [];
	if (process.env.OBSIDIAN_CLI) candidates.push(process.env.OBSIDIAN_CLI);
	if (process.platform === "win32") {
		const located = spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-Command",
				"(Get-Process -Name Obsidian -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1 -ExpandProperty Path)",
			],
			{ encoding: "utf8" },
		);
		const exe = (located.stdout ?? "").trim();
		if (exe) candidates.push(join(dirname(exe), "Obsidian.com"));
		if (process.env.LOCALAPPDATA) {
			candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.com"));
		}
	}
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return "obsidian";
}

/** Ask the running app to unload and load the plugin again. A closed app needs no reset. */
function reloadPlugin(vaultName, pluginId) {
	const cli = obsidianCliPath();
	const result = spawnSync(cli, ["plugin:reload", `id=${pluginId}`, `vault=${vaultName}`], {
		encoding: "utf8",
		shell: false,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.error) {
		throw new Error(`Could not run the Obsidian CLI (${cli}): ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`Obsidian did not reload ${pluginId} in ${vaultName}.${output ? ` ${output}` : ""}`,
		);
	}
	console.error(output || `Reloaded ${pluginId} in ${vaultName}.`);
}

if (
	process.argv[1]
	&& resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const options = parseArguments(process.argv.slice(2));
		if (options.help) usage();
		else {
			const result = deployRelease(options);
			console.log(JSON.stringify(result, null, 2));
			if (!options.dryRun) {
				const pluginId = readManifest(PROJECT_ROOT).id;
				for (const vault of result.vaults) reloadPlugin(vault.name, pluginId);
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
