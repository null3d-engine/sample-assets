// Checks that the manifest, the README and the files agree, or brings the manifest and the README
// up to date with the files.
//
//   bun scripts/manifest.ts           check, and fail with a list of every problem
//   bun scripts/manifest.ts --write   record each file's size and hash, and rewrite the README table
//
// The check covers: every file under sources/ belongs to one asset, with the size and SHA-256 that
// the manifest records; every asset has its attribution (title, authors, source, licence, fetch date
// and changes) under an accepted licence whose text is in LICENSES/; no file passes the size limit;
// no image passes the texture size limit; generated assets come out the same when generated again;
// and the README's asset table is the one the manifest gives.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Asset,
	imagesIn,
	MANIFEST,
	MAX_FILE_BYTES,
	MAX_TEXTURE_SIDE,
	type Manifest,
	manifestText,
	megabytes,
	README,
	ROOT,
	readManifest,
	scanFiles,
	walk,
} from './lib.ts';

/** Licences the repository accepts: CC0 and CC BY, which allow redistribution and commercial use. */
const ACCEPTED = /^(CC0-1\.0|CC-BY-[34]\.0)$/;
const START = '<!-- manifest:start -->';
const END = '<!-- manifest:end -->';

const GROUPS: [string, string][] = [
	['khronos/', 'Khronos glTF sample models'],
	['characters/', 'Characters'],
	['city/', 'City'],
	['materials/', 'Materials'],
	['hdri/', 'Environments'],
	['luts', 'Colour grading tables'],
];

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

function authorsText(asset: Asset): string {
	return asset.authors
		.map((a) => {
			const parts = [a.role, a.license].filter(Boolean);
			return parts.length > 0 ? `${a.name} (${parts.join(', ')})` : a.name;
		})
		.join('; ');
}

/** The README's generated part: totals, then one table per group of assets. */
export function readmeTable(manifest: Manifest): string {
	const allFiles = manifest.assets.flatMap((a) => a.files);
	const total = allFiles.reduce((sum, f) => sum + f.bytes, 0);
	const lines = [
		START,
		'',
		`${manifest.assets.length} assets, ${allFiles.length} files, ${megabytes(total)} MB. Generated from \`manifest.json\` by \`bun scripts/manifest.ts --write\`.`,
	];
	for (const [prefix, heading] of GROUPS) {
		const assets = manifest.assets.filter((a) => a.id.startsWith(prefix));
		if (assets.length === 0) continue;
		lines.push(
			'',
			`### ${heading}`,
			'',
			'| Asset | Title | Purpose | Authors | Licence | Fetched | Changes | Files |',
			'| --- | --- | --- | --- | --- | --- | --- | --- |',
		);
		for (const a of assets) {
			const licences = a.license.map((id) => `[${id}](${manifest.licenses[id]?.url ?? ''})`).join(', ');
			const bytes = a.files.reduce((sum, f) => sum + f.bytes, 0);
			const files = `${a.files.length}, ${megabytes(bytes)} MB`;
			lines.push(
				`| \`${a.id}\` | [${cell(a.title)}](${a.source}) | ${cell(a.purpose)} | ${cell(authorsText(a))} | ${licences} | ${a.fetched} | ${cell(a.changes)} | ${files} |`,
			);
		}
	}
	lines.push('', END);
	return lines.join('\n');
}

function replaceTable(readme: string, table: string): string {
	const start = readme.indexOf(START);
	const end = readme.indexOf(END);
	if (start < 0 || end < start) throw new Error(`${README} lacks the ${START} and ${END} markers`);
	return readme.slice(0, start) + table + readme.slice(end + END.length);
}

function checkAttribution(manifest: Manifest, problems: string[]) {
	for (const [id, licence] of Object.entries(manifest.licenses)) {
		if (!ACCEPTED.test(id)) problems.push(`Licence ${id} is not CC0 or CC BY`);
		if (!existsSync(join(ROOT, licence.file))) problems.push(`Licence ${id}: ${licence.file} is missing`);
	}
	const ids = new Set<string>();
	for (const a of manifest.assets) {
		if (ids.has(a.id)) problems.push(`${a.id}: the id appears twice`);
		ids.add(a.id);
		for (const field of ['title', 'purpose', 'source', 'changes', 'dir'] as const) {
			if (!a[field]?.trim()) problems.push(`${a.id}: no ${field}`);
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(a.fetched)) problems.push(`${a.id}: no fetch date`);
		if (a.authors.length === 0) problems.push(`${a.id}: no author`);
		if (a.license.length === 0) problems.push(`${a.id}: no licence`);
		for (const id of a.license) {
			if (!manifest.licenses[id]) problems.push(`${a.id}: licence ${id} is not in the licence list`);
		}
		const partLicences = new Set(a.authors.map((p) => p.license).filter(Boolean));
		if (partLicences.size > 0 && [...partLicences].sort().join() !== [...a.license].sort().join()) {
			problems.push(`${a.id}: the authors' licences differ from the asset's licences`);
		}
		if (!a.dir.startsWith('sources/')) problems.push(`${a.id}: its folder is outside sources/`);
	}
	for (const a of manifest.assets) {
		for (const b of manifest.assets) {
			if (a !== b && `${a.dir}/`.startsWith(`${b.dir}/`)) problems.push(`${a.id}: its folder is inside ${b.id}'s`);
		}
	}
}

function checkFiles(manifest: Manifest, problems: string[]) {
	const owned = new Set<string>();
	for (const a of manifest.assets) {
		const actual = scanFiles(ROOT, a.dir);
		const recorded = new Map(a.files.map((f) => [f.path, f]));
		if (actual.length === 0) problems.push(`${a.id}: no files in ${a.dir}`);
		for (const f of actual) {
			owned.add(f.path);
			const r = recorded.get(f.path);
			if (!r) problems.push(`${f.path}: not in the manifest`);
			else if (r.bytes !== f.bytes || r.sha256 !== f.sha256) problems.push(`${f.path}: size or SHA-256 differs from the manifest`);
			recorded.delete(f.path);
			if (f.bytes > MAX_FILE_BYTES) problems.push(`${f.path}: ${megabytes(f.bytes)} MB, over the limit of ${megabytes(MAX_FILE_BYTES)} MB`);
			for (const image of imagesIn(f.path, readFileSync(join(ROOT, f.path)))) {
				if (image.width > MAX_TEXTURE_SIDE || image.height > MAX_TEXTURE_SIDE) {
					problems.push(`${image.where}: ${image.width} x ${image.height}, over ${MAX_TEXTURE_SIDE} x ${MAX_TEXTURE_SIDE}`);
				}
			}
		}
		for (const path of recorded.keys()) problems.push(`${path}: in the manifest but missing`);
	}
	for (const path of walk(ROOT, 'sources')) {
		if (!owned.has(path)) problems.push(`${path}: belongs to no asset`);
	}
}

/** Generates each generated asset again in a scratch folder and compares the bytes. */
function checkGenerated(manifest: Manifest, problems: string[]) {
	for (const a of manifest.assets) {
		if (a.origin.kind !== 'generated') continue;
		const scratch = mkdtempSync(join(tmpdir(), 'sample-assets-check-'));
		try {
			const run = Bun.spawnSync(['bun', join(ROOT, a.origin.script), scratch], { stderr: 'pipe' });
			if (run.exitCode !== 0) {
				problems.push(`${a.id}: ${a.origin.script} failed: ${run.stderr}`);
				continue;
			}
			const again = scanFiles(scratch, '.').map((f) => `${f.path.replace(/^\.\//, '')} ${f.sha256}`);
			const committed = a.files.map((f) => `${f.path.slice(a.dir.length + 1)} ${f.sha256}`);
			if (again.sort().join('\n') !== committed.sort().join('\n')) {
				problems.push(`${a.id}: ${a.origin.script} gives different files from the committed ones`);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
}

if (import.meta.main) {
	const manifest = readManifest();
	const readme = readFileSync(join(ROOT, README), 'utf8');
	if (process.argv.includes('--write')) {
		for (const a of manifest.assets) a.files = scanFiles(ROOT, a.dir);
		await Bun.write(join(ROOT, MANIFEST), manifestText(manifest));
		await Bun.write(join(ROOT, README), replaceTable(readme, readmeTable(manifest)));
	}
	const problems: string[] = [];
	checkAttribution(manifest, problems);
	checkFiles(manifest, problems);
	checkGenerated(manifest, problems);
	const current = readFileSync(join(ROOT, README), 'utf8');
	if (replaceTable(current, readmeTable(manifest)) !== current) {
		problems.push(`${README}: the asset table differs from the manifest; run bun scripts/manifest.ts --write`);
	}
	const files = manifest.assets.flatMap((a) => a.files);
	const total = files.reduce((sum, f) => sum + f.bytes, 0);
	console.log(`${manifest.assets.length} assets, ${files.length} files, ${megabytes(total)} MB`);
	if (problems.length > 0) {
		console.error(problems.map((p) => `- ${p}`).join('\n'));
		process.exit(1);
	}
}
