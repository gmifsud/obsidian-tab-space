import { mkdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");

/** Files Obsidian loads from a plugin folder. */
const RELEASE_FILES = ["main.js", "manifest.json", "styles.css"];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of RELEASE_FILES) {
	await copyFile(join(root, file), join(dist, file));
}

console.log(`Packaged ${RELEASE_FILES.join(", ")} → dist/`);
console.log("Copy dist/ into <vault>/.obsidian/plugins/working-tabs/");
