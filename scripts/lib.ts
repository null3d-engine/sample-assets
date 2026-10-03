// Shared pieces of the repository's scripts: the manifest's types, file hashes, the walk over the
// source folders, and the image size reader behind the texture size limit.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

export const ROOT = join(import.meta.dir, '..');
export const MANIFEST = 'manifest.json';
export const README = 'README.md';

/** The largest file the repository accepts, in bytes. */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
/** The largest texture side the asset tool encodes. */
export const MAX_TEXTURE_SIDE = 2048;

export interface Licence {
	name: string;
	url: string;
	file: string;
}

export interface Author {
	name: string;
	/** What this author made, when an asset has several authors. */
	role?: string;
	/** The licence of this author's part, when the parts of an asset differ. */
	license?: string;
}

export type Origin =
	| { kind: 'khronos'; commit: string; model: string; variants: string[] }
	| { kind: 'github'; repo: string; commit: string; files: Record<string, string> }
	| { kind: 'zip'; url: string; files: Record<string, string> }
	| { kind: 'ambientcg'; id: string; resolution: string; maps: string[] }
	| { kind: 'polyhaven'; id: string; files: { resolution: string; format: string }[] }
	| { kind: 'generated'; script: string };

export interface FileEntry {
	path: string;
	bytes: number;
	sha256: string;
}

export interface Asset {
	id: string;
	title: string;
	purpose: string;
	authors: Author[];
	license: string[];
	source: string;
	fetched: string;
	changes: string;
	dir: string;
	origin: Origin;
	files: FileEntry[];
}

export interface Manifest {
	version: number;
	licenses: Record<string, Licence>;
	assets: Asset[];
}

export function readManifest(root = ROOT): Manifest {
	return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
}

export function manifestText(manifest: Manifest): string {
	return `${JSON.stringify(manifest, null, '\t')}\n`;
}

export function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Repository-relative paths, with forward slashes, of every file under `dir`, sorted. */
export function walk(root: string, dir: string): string[] {
	const out: string[] = [];
	const visit = (rel: string) => {
		for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
			const path = posix.join(rel, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.name !== '.DS_Store') out.push(path);
		}
	};
	if (existsSync(join(root, dir))) visit(dir);
	return out.sort();
}

/** The size and hash of each file under the asset's folder. */
export function scanFiles(root: string, dir: string): FileEntry[] {
	return walk(root, dir).map((path) => {
		const bytes = readFileSync(join(root, path));
		return { path, bytes: statSync(join(root, path)).size, sha256: sha256(bytes) };
	});
}

export interface ImageSize {
	/** Where the image sits: the file, or the file and the image's index inside a glTF file. */
	where: string;
	width: number;
	height: number;
}

/** The width and height of a PNG, JPEG, KTX2, Radiance HDR or OpenEXR image, or null for other data. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b, view);
	if (b.length > 28 && b[1] === 0x4b && b[2] === 0x54 && b[3] === 0x58 && b[5] === 0x32) {
		return { width: view.getUint32(20, true), height: view.getUint32(24, true) };
	}
	if (b.length > 2 && b[0] === 0x23 && b[1] === 0x3f) return hdrSize(b);
	if (b.length > 8 && view.getUint32(0, true) === 20000630) return exrSize(b, view);
	return null;
}

function jpegSize(b: Uint8Array, view: DataView) {
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return null;
		const marker = b[i + 1];
		const length = view.getUint16(i + 2);
		const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
		if (isFrame) return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
		i += 2 + length;
	}
	return null;
}

function hdrSize(b: Uint8Array) {
	const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 4096)));
	const match = head.match(/\n[-+]Y (\d+) [-+]X (\d+)\n/);
	return match ? { width: Number(match[2]), height: Number(match[1]) } : null;
}

function exrSize(b: Uint8Array, view: DataView) {
	let i = 8;
	const text = () => {
		const end = b.indexOf(0, i);
		const s = new TextDecoder('latin1').decode(b.subarray(i, end));
		i = end + 1;
		return s;
	};
	while (i < b.length && b[i] !== 0) {
		const name = text();
		text();
		const size = view.getInt32(i, true);
		i += 4;
		if (name === 'dataWindow') {
			const [x0, y0, x1, y1] = [0, 4, 8, 12].map((o) => view.getInt32(i + o, true));
			return { width: x1 - x0 + 1, height: y1 - y0 + 1 };
		}
		i += size;
	}
	return null;
}

/** The images a file holds: the file itself, or each image embedded in a glTF or GLB file. */
export function imagesIn(path: string, b: Uint8Array): ImageSize[] {
	const lower = path.toLowerCase();
	if (lower.endsWith('.glb') || lower.endsWith('.gltf')) return gltfImages(path, b);
	const size = imageSize(b);
	return size ? [{ where: path, ...size }] : [];
}

function gltfImages(path: string, b: Uint8Array): ImageSize[] {
	let json: {
		images?: { bufferView?: number; uri?: string }[];
		bufferViews?: { byteOffset?: number; byteLength: number }[];
	};
	let bin: Uint8Array | null = null;
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (view.getUint32(0, true) === 0x46546c67) {
		const jsonLength = view.getUint32(12, true);
		json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jsonLength)));
		const binStart = 20 + jsonLength;
		if (binStart + 8 <= b.length) {
			const binLength = view.getUint32(binStart, true);
			bin = b.subarray(binStart + 8, binStart + 8 + binLength);
		}
	} else {
		json = JSON.parse(new TextDecoder().decode(b));
	}
	const out: ImageSize[] = [];
	(json.images ?? []).forEach((image, index) => {
		let data: Uint8Array | null = null;
		if (image.bufferView !== undefined && bin) {
			const bv = json.bufferViews?.[image.bufferView];
			if (bv) data = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
		} else if (image.uri?.startsWith('data:')) {
			data = Buffer.from(image.uri.slice(image.uri.indexOf(',') + 1), 'base64');
		}
		const size = data ? imageSize(data) : null;
		if (size) out.push({ where: `${path} image ${index}`, ...size });
	});
	return out;
}

/** The repository's file size in megabytes, as the README prints it. */
export function megabytes(bytes: number): string {
	return (bytes / 1e6).toFixed(2);
}
