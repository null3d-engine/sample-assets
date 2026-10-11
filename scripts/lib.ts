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
	| { kind: 'files'; files: Record<string, string> }
	| { kind: 'ambientcg'; id: string; resolution: string; maps: string[] }
	| { kind: 'polyhaven'; id: string; files: { resolution: string; format: string }[] }
	| { kind: 'generated'; script: string }
	/** A model that a Blender script in another repository builds: `script` links to it. */
	| { kind: 'blender'; script: string };

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

// Binary glTF files, for the scripts that generate models.

// biome-ignore lint/suspicious/noExplicitAny: glTF JSON
type GltfJson = any;

export const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
export const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** A binary glTF file's JSON and its binary chunk. */
export function readGlb(glb: Buffer): { json: GltfJson; bin: Buffer } {
	const jsonLength = glb.readUInt32LE(12);
	const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
	const binStart = 20 + jsonLength + 8;
	return { json, bin: glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLength)) };
}

/** An accessor's values as numbers, element by element, with normalized integers as fractions. */
export function accessorValues(json: GltfJson, bin: Buffer, index: number): number[] {
	const accessor = json.accessors[index];
	const view = json.bufferViews[accessor.bufferView];
	const size = COMPONENTS[accessor.type] as number;
	const bytes = COMPONENT_BYTES[accessor.componentType] as number;
	const stride = view.byteStride ?? size * bytes;
	const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
	const values: number[] = [];
	for (let i = 0; i < accessor.count; i++) {
		for (let c = 0; c < size; c++) {
			const at = start + i * stride + c * bytes;
			let value: number;
			switch (accessor.componentType) {
				case 5126:
					value = bin.readFloatLE(at);
					break;
				case 5125:
					value = bin.readUInt32LE(at);
					break;
				case 5123:
					value = bin.readUInt16LE(at);
					if (accessor.normalized) value /= 65535;
					break;
				case 5121:
					value = bin.readUInt8(at);
					if (accessor.normalized) value /= 255;
					break;
				default:
					throw new Error(`Accessor ${index} has component type ${accessor.componentType}`);
			}
			values.push(value);
		}
	}
	return values;
}

/** A binary glTF file of the JSON and the binary chunk, each padded to four bytes. */
export function writeGlb(json: GltfJson, bin: Buffer): Buffer {
	const data = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
	json.buffers = [{ byteLength: data.length }];
	let text = Buffer.from(JSON.stringify(json), 'utf8');
	text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
	const header = Buffer.alloc(12);
	header.writeUInt32LE(0x46546c67, 0);
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(12 + 8 + text.length + 8 + data.length, 8);
	const chunk = (length: number, type: number) => {
		const b = Buffer.alloc(8);
		b.writeUInt32LE(length, 0);
		b.writeUInt32LE(type, 4);
		return b;
	};
	return Buffer.concat([header, chunk(text.length, 0x4e4f534a), text, chunk(data.length, 0x004e4942), data]);
}

/**
 * The surface class of each part of a battle unit, which the engine's Battle shaders read from the
 * alpha of each vertex color: skin, glowing vents, rubber and leather and wood, bare metal, painted
 * steel, and cloth.
 */
export const PART = { skin: 0, glow: 0.2, rubber: 0.4, metal: 0.6, paint: 0.8, cloth: 1 } as const;

/**
 * Texture coordinates in the model's units, projected along each vertex's main axis as a box
 * projects them: across x and up y on the faces toward z, across z and up y on the faces toward x,
 * and across x and z on the faces toward y. A texture of a weave or of panels then keeps one size
 * over the whole model, with no texture of its own.
 */
export function boxUvs(position: readonly number[], normal: readonly number[]): number[] {
	const uv: number[] = [];
	for (let v = 0; v < position.length / 3; v++) {
		const [x, y, z] = position.slice(v * 3, v * 3 + 3) as [number, number, number];
		const [ax, ay, az] = normal.slice(v * 3, v * 3 + 3).map(Math.abs) as [number, number, number];
		if (ax >= ay && ax >= az) uv.push(z, y);
		else if (ay >= az) uv.push(x, z);
		else uv.push(x, y);
	}
	return uv;
}
