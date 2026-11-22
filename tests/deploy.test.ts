import { createHash } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { deployRelease } from '../scripts/deploy.mjs';

const outputRoot = resolve(process.cwd(), '.test-output/deploy-tests');
const projectRoot = join(outputRoot, 'project');
const releaseFiles = ['main.js', 'manifest.json', 'styles.css'] as const;
const hash = (path: string) =>
	createHash('sha256').update(readFileSync(path)).digest('hex');

function createVault(name: string): string {
	const vault = join(outputRoot, name);
	mkdirSync(join(vault, '.obsidian'), { recursive: true });
	return vault;
}

function pluginDirectory(vault: string): string {
	return join(vault, '.obsidian', 'plugins', 'working-tabs');
}

function seedChangedPlugin(vault: string): void {
	const plugin = pluginDirectory(vault);
	mkdirSync(plugin, { recursive: true });
	for (const file of releaseFiles) {
		writeFileSync(join(plugin, file), `old-${file}`);
	}
	writeFileSync(join(plugin, 'data.json'), '{"custom":true}');
	writeFileSync(join(plugin, 'unrelated.txt'), 'keep me');
}

beforeEach(() => {
	rmSync(outputRoot, { recursive: true, force: true });
	mkdirSync(projectRoot, { recursive: true });
	for (const file of releaseFiles) {
		copyFileSync(resolve(process.cwd(), file), join(projectRoot, file));
	}
});

describe('safe deployment', () => {
	it('preflights every vault before writing and rejects missing Obsidian config', () => {
		const valid = createVault('valid');
		const invalid = join(outputRoot, 'not-a-vault');
		mkdirSync(invalid, { recursive: true });

		expect(() =>
			deployRelease({
				vaults: [valid, invalid],
				projectRoot,
				skipBuild: true,
				dryRun: true,
			})
		).toThrow(/\.obsidian/);
		expect(existsSync(join(valid, '.obsidian/plugins'))).toBe(false);
	});

	it('deploys release files only, preserves data, backs up changes, and is idempotent', () => {
		const vault = createVault('vault-a');
		seedChangedPlugin(vault);

		const first = deployRelease({
			vaults: [vault],
			projectRoot,
			skipBuild: true,
			deploymentId: 'first',
		});
		const plugin = pluginDirectory(vault);
		for (const file of releaseFiles) {
			expect(hash(join(plugin, file))).toBe(hash(join(projectRoot, file)));
		}
		expect(readFileSync(join(plugin, 'data.json'), 'utf8')).toBe('{"custom":true}');
		expect(readFileSync(join(plugin, 'unrelated.txt'), 'utf8')).toBe('keep me');
		expect(first.changed).toBe(true);

		const backup = join(plugin, '.working-tabs-backups', 'first');
		expect(releaseFiles.every((file) => existsSync(join(backup, file)))).toBe(true);

		const second = deployRelease({
			vaults: [vault],
			skipBuild: true,
			projectRoot,
			deploymentId: 'second',
		});
		expect(second.changed).toBe(false);
		expect(second.vaults[0].changed).toEqual([]);
	});

	it('supports strict config and environment expansion without dry-run writes', () => {
		const vault = createVault('configured');
		const config = {
			$schema: './deploy-config.schema.json',
			backup: true,
			vaults: [
				{
					name: 'Configured',
					path: '${WORKING_TABS_VAULT}',
					enabled: true,
				},
			],
		};
		const configPath = join(outputRoot, 'config.json');
		writeFileSync(configPath, JSON.stringify(config));

		const result = deployRelease({
			configPath,
			projectRoot,
			skipBuild: true,
			dryRun: true,
			environment: { WORKING_TABS_VAULT: vault },
		});
		expect(result.dryRun).toBe(true);
		expect(existsSync(pluginDirectory(vault))).toBe(false);

		writeFileSync(
			configPath,
			JSON.stringify({ ...config, unexpected: true }),
		);
		expect(() =>
			deployRelease({ configPath, projectRoot, skipBuild: true, dryRun: true })
		).toThrow(/Unknown config property/);
	});

	it('explains Windows JSON path escaping', () => {
		const configPath = join(outputRoot, 'invalid.json');
		writeFileSync(
			configPath,
			'{"backup":true,"vaults":[{"name":"Bad","path":"D:\\Vault","enabled":true}]}',
		);

		const expected = process.platform === 'win32'
			? /forward slashes or double every backslash/
			: /strict JSON/;
		expect(() =>
			deployRelease({ configPath, projectRoot, skipBuild: true, dryRun: true })
		).toThrow(expected);
	});

	it('rejects overlapping and symlink-escaping vault paths', () => {
		const vault = createVault('overlap');
		expect(() =>
			deployRelease({
				vaults: [vault, vault],
				projectRoot,
				skipBuild: true,
				dryRun: true,
			})
		).toThrow(/Overlapping/);

		const link = join(outputRoot, 'linked-vault');
		symlinkSync(vault, link, process.platform === 'win32' ? 'junction' : 'dir');
		expect(() =>
			deployRelease({
				vaults: [link],
				projectRoot,
				skipBuild: true,
				dryRun: true,
			})
		).toThrow(/Symbolic links/);
	});

	it('rolls back every completed write after a multi-vault partial failure', () => {
		const first = createVault('rollback-a');
		const second = createVault('rollback-b');
		seedChangedPlugin(first);
		seedChangedPlugin(second);
		const beforeFirst = releaseFiles.map((file) =>
			readFileSync(join(pluginDirectory(first), file), 'utf8')
		);
		const beforeSecond = releaseFiles.map((file) =>
			readFileSync(join(pluginDirectory(second), file), 'utf8')
		);

		expect(() =>
			deployRelease({
				vaults: [first, second],
				projectRoot,
				skipBuild: true,
				deploymentId: 'rollback',
				hooks: {
					beforeCommit: ({ index }: { index: number }) => {
						if (index === 3) throw new Error('injected failure');
					},
				},
			})
		).toThrow(/rolled back/);

		expect(
			releaseFiles.map((file) =>
				readFileSync(join(pluginDirectory(first), file), 'utf8')
			)
		).toEqual(beforeFirst);
		expect(
			releaseFiles.map((file) =>
				readFileSync(join(pluginDirectory(second), file), 'utf8')
			)
		).toEqual(beforeSecond);
		expect(readFileSync(join(pluginDirectory(first), 'data.json'), 'utf8')).toBe(
			'{"custom":true}',
		);
	});
});
