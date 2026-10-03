// Downloads assets from the origins that the manifest records, into each asset's folder.
//
//   bun scripts/import.ts <asset id>...   import these assets again
//   bun scripts/import.ts --missing       import every asset whose folder is empty
//
// An import replaces the asset's folder, sets its fetch date to today, and fills its title and
// authors from the source's catalogue when the manifest leaves them empty. Run
// `bun scripts/manifest.ts --write` after it to record the files' sizes and hashes.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Asset, MANIFEST, manifestText, type Origin, ROOT, readManifest, walk } from './lib.ts';

const USER_AGENT = 'null3d-sample-assets (https://github.com/null3d-engine/sample-assets)';

async function download(url: string, headers: Record<string, string> = {}): Promise<Uint8Array> {
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
		if (response.ok) return new Uint8Array(await response.arrayBuffer());
		if (attempt === 3) throw new Error(`${url}: HTTP ${response.status}`);
		await Bun.sleep(1000 * attempt);
	}
}

async function json<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
	return JSON.parse(new TextDecoder().decode(await download(url, headers)));
}

function githubHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

async function fromGithub(repo: string, commit: string, files: Record<string, string>, dir: string) {
	await Promise.all(
		Object.entries(files).map(async ([from, to]) => {
			const url = `https://raw.githubusercontent.com/${repo}/${commit}/${encodePath(from)}`;
			await Bun.write(join(ROOT, dir, to), await download(url, githubHeaders()));
		}),
	);
}

const khronosTrees = new Map<string, { path: string; type: string }[]>();

async function khronosFiles(commit: string, model: string, variants: string[]) {
	if (!khronosTrees.has(commit)) {
		const url = `https://api.github.com/repos/KhronosGroup/glTF-Sample-Assets/git/trees/${commit}?recursive=1`;
		const tree = await json<{ tree: { path: string; type: string }[]; truncated: boolean }>(url, githubHeaders());
		if (tree.truncated) throw new Error('The Khronos file list came back truncated');
		khronosTrees.set(commit, tree.tree);
	}
	const base = `Models/${model}/`;
	const keep = variants.map((v) => `${base}${v}/`);
	const files: Record<string, string> = {};
	for (const entry of khronosTrees.get(commit) ?? []) {
		if (entry.type !== 'blob') continue;
		const legal = entry.path === `${base}LICENSE.md` || entry.path === `${base}metadata.json`;
		if (legal || keep.some((prefix) => entry.path.startsWith(prefix))) {
			files[entry.path] = entry.path.slice(base.length);
		}
	}
	return files;
}

/** Downloads a zip file, unpacks it into a scratch folder, and hands that folder to `use`. */
async function withZip(url: string, use: (folder: string) => void) {
	const work = mkdtempSync(join(tmpdir(), 'sample-assets-'));
	try {
		const zip = join(work, 'download.zip');
		await Bun.write(zip, await download(url));
		const unzip = Bun.spawnSync(['unzip', '-q', '-o', zip, '-d', join(work, 'x')]);
		if (unzip.exitCode !== 0) throw new Error(`${url}: unzip failed: ${unzip.stderr}`);
		use(join(work, 'x'));
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** Copies the zip's entries: a key ending in a slash copies that folder's whole tree. */
async function fromZip(url: string, files: Record<string, string>, dir: string) {
	await withZip(url, (folder) => {
		for (const [from, to] of Object.entries(files)) {
			const source = join(folder, from);
			if (!existsSync(source)) throw new Error(`${url}: no entry ${from}`);
			const target = join(ROOT, dir, to);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(source, target, { recursive: true });
		}
	});
}

/** Copies the maps that the set has, out of the ones the origin names. */
async function fromAmbientCg(asset: Asset, origin: Extract<Origin, { kind: 'ambientcg' }>) {
	const name = `${origin.id}_${origin.resolution}`;
	await withZip(`https://ambientcg.com/get?file=${name}.zip`, (folder) => {
		const present = readdirSync(folder);
		for (const map of origin.maps) {
			const file = present.find((f) => f.startsWith(`${name}_${map}.`));
			if (file) cpSync(join(folder, file), join(ROOT, asset.dir, file));
		}
	});
	if (!asset.title) {
		const url = `https://ambientcg.com/api/v2/full_json?id=${origin.id}&include=displayData`;
		const found = await json<{ foundAssets: { displayName: string }[] }>(url);
		asset.title = found.foundAssets[0]?.displayName ?? origin.id;
	}
}

async function fromPolyHaven(asset: Asset, origin: Extract<Origin, { kind: 'polyhaven' }>) {
	const files = await json<{ hdri: Record<string, Record<string, { url: string; md5: string }>> }>(
		`https://api.polyhaven.com/files/${origin.id}`,
	);
	for (const { resolution, format } of origin.files) {
		const file = files.hdri[resolution]?.[format];
		if (!file) throw new Error(`${origin.id}: no ${resolution} ${format} file`);
		const bytes = await download(file.url);
		const md5 = createHash('md5').update(bytes).digest('hex');
		if (md5 !== file.md5) throw new Error(`${file.url}: MD5 ${md5}, expected ${file.md5}`);
		await Bun.write(join(ROOT, asset.dir, `${origin.id}_${resolution}.${format}`), bytes);
	}
	if (!asset.title || asset.authors.length === 0) {
		const info = await json<{ name: string; authors: Record<string, string> }>(
			`https://api.polyhaven.com/info/${origin.id}`,
		);
		asset.title ||= info.name;
		if (asset.authors.length === 0) {
			asset.authors = Object.entries(info.authors).map(([name, role]) =>
				role === 'All' ? { name } : { name, role: role.charAt(0).toLowerCase() + role.slice(1) },
			);
		}
	}
}

async function importAsset(asset: Asset) {
	const origin = asset.origin;
	rmSync(join(ROOT, asset.dir), { recursive: true, force: true });
	mkdirSync(join(ROOT, asset.dir), { recursive: true });
	switch (origin.kind) {
		case 'khronos':
			await fromGithub(
				'KhronosGroup/glTF-Sample-Assets',
				origin.commit,
				await khronosFiles(origin.commit, origin.model, origin.variants),
				asset.dir,
			);
			break;
		case 'github':
			await fromGithub(origin.repo, origin.commit, origin.files, asset.dir);
			break;
		case 'zip':
			await fromZip(origin.url, origin.files, asset.dir);
			break;
		case 'ambientcg':
			await fromAmbientCg(asset, origin);
			break;
		case 'polyhaven':
			await fromPolyHaven(asset, origin);
			break;
		case 'generated': {
			const run = Bun.spawnSync(['bun', join(ROOT, origin.script), join(ROOT, asset.dir)], {
				stdout: 'inherit',
				stderr: 'inherit',
			});
			if (run.exitCode !== 0) throw new Error(`${origin.script} failed`);
			break;
		}
	}
	asset.fetched = new Date().toISOString().slice(0, 10);
	const files = walk(ROOT, asset.dir);
	const bytes = files.reduce((sum, f) => sum + statSync(join(ROOT, f)).size, 0);
	console.log(`${asset.id}: ${files.length} files, ${(bytes / 1e6).toFixed(2)} MB`);
}

const args = process.argv.slice(2);
const manifest = readManifest();
const chosen = manifest.assets.filter(
	(a) => args.includes(a.id) || (args.includes('--missing') && walk(ROOT, a.dir).length === 0),
);
const unknown = args.filter((a) => !a.startsWith('--') && !manifest.assets.some((x) => x.id === a));
if (unknown.length > 0) throw new Error(`No asset with the id ${unknown.join(', ')}`);

// A few downloads at a time keep each source's servers responsive. Generated assets read downloaded
// ones, so they run last. The manifest is saved even when an import fails, so the assets that did
// arrive keep their fetch dates.
const downloads = chosen.filter((a) => a.origin.kind !== 'generated');
try {
	await Promise.all(
		Array.from({ length: 4 }, async () => {
			for (let asset = downloads.shift(); asset; asset = downloads.shift()) await importAsset(asset);
		}),
	);
	for (const asset of chosen.filter((a) => a.origin.kind === 'generated')) await importAsset(asset);
} finally {
	await Bun.write(join(ROOT, MANIFEST), manifestText(manifest));
}
