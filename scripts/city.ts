// Generates the city layout: a grid of blocks with roads, buildings, street props, 200 materials,
// 32 street lights, a camera path through the streets and labels on the tallest towers. A fixed seed
// gives the same file on every run, so the layout can be regenerated and compared.
//
//   bun scripts/city.ts <output folder> [--seed <n>]
//
// The output is layout.json, in metres with +Y up:
// - models: the Kenney models the objects use, as repository paths.
// - materials: ambientCG texture sets, each with a tint and the metres one texture repeat covers.
// - objects.rows: one row per object, with the fields that objects.fields names. A model of -1 is a
//   unit box, from -0.5 to 0.5 on X and Z and from 0 to 1 on Y, which the scale stretches; a
//   material of -1 keeps the model's own material; a building of -1 marks an object that belongs to
//   no building. The position is the centre of the object's base.
// - lights: point lights at the street lights nearest the camera path.
// - camera: a closed path along the road centre lines, at a fixed height and speed.
// - labels: names for the tallest buildings.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.ts';

const TILE = 10; // metres per road tile; the Kenney kits' tiles are one unit wide
const KIT_SCALE = TILE;
const BLOCKS = 12; // blocks per side
const BLOCK_TILES = 6; // land tiles per block side
const PITCH = BLOCK_TILES + 1; // a block and its road
const SIDE = BLOCKS * PITCH + 1; // tiles per city side
const LOT = 2; // tiles per lot side, so each block holds 3 x 3 lots
const LIGHTS = 32;
const LABELS = 8;

const seedArg = process.argv.indexOf('--seed');
const SEED = seedArg > 0 ? Number(process.argv[seedArg + 1]) : 1;

/** Mulberry32: a small seeded generator with an even spread. */
function random(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = random(SEED);
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
const chance = (p: number) => rand() < p;
const fixed = (x: number, digits: number) => Number(x.toFixed(digits));
const quarterTurn = (a: number) => fixed(Math.round(a / (Math.PI / 2)) * (Math.PI / 2), 4);

// Models: each Kenney GLB file that the layout uses, with its size from the position bounds.
const KITS = ['commercial', 'suburban', 'roads', 'industrial'] as const;
type Kit = (typeof KITS)[number];
const models: string[] = [];
const modelSize: [number, number, number][] = [];
const modelIndex = new Map<string, number>();

function modelBounds(path: string): [number, number, number] {
	const b = readFileSync(join(ROOT, path));
	const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const mesh of json.meshes) {
		for (const primitive of mesh.primitives) {
			const accessor = json.accessors[primitive.attributes.POSITION];
			for (let i = 0; i < 3; i++) {
				min[i] = Math.min(min[i] as number, accessor.min[i]);
				max[i] = Math.max(max[i] as number, accessor.max[i]);
			}
		}
	}
	return [0, 1, 2].map((i) => ((max[i] as number) - (min[i] as number)) * KIT_SCALE) as [number, number, number];
}

function model(kit: Kit, name: string): number {
	const path = `sources/city/kenney-${kit}/glb/${name}.glb`;
	let index = modelIndex.get(path);
	if (index === undefined) {
		index = models.length;
		models.push(path);
		modelSize.push(modelBounds(path));
		modelIndex.set(path, index);
	}
	return index;
}

const kitNames = (kit: Kit, prefix: string) =>
	readdirSync(join(ROOT, `sources/city/kenney-${kit}/glb`))
		.filter((f) => f.startsWith(prefix) && f.endsWith('.glb'))
		.map((f) => f.slice(0, -4))
		.sort();

// Materials: every texture set in five tints, each from one family of surfaces.
const FAMILIES: Record<string, { sets: RegExp; metresPerRepeat: number }> = {
	wall: { sets: /^(Bricks|Facade|Concrete|Plaster|PaintedPlaster|Tiles|WoodSiding)/, metresPerRepeat: 3 },
	roof: { sets: /^(RoofingTiles|CorrugatedSteel|MetalPlates)/, metresPerRepeat: 2 },
	ground: { sets: /^(PavingStones|Asphalt|Road|Planks)/, metresPerRepeat: 3 },
};
const REPEAT: [RegExp, number][] = [
	[/^Bricks/, 2],
	[/^Facade/, 8],
	[/^Tiles/, 1.5],
	[/^Road/, 8],
	[/^Asphalt/, 4],
];
const TINTS = 5;
const materialDir = 'sources/materials/ambientcg';
const sets = readdirSync(join(ROOT, materialDir)).sort();
const MAP_KEYS: Record<string, string> = {
	Color: 'color',
	NormalGL: 'normal',
	Roughness: 'roughness',
	AmbientOcclusion: 'occlusion',
	Metalness: 'metalness',
	Emission: 'emission',
};
const materials: { set: string; family: string; maps: Record<string, string>; tint: number[]; metresPerRepeat: number }[] = [];
const byFamily: Record<string, number[]> = { wall: [], roof: [], ground: [] };
for (const set of sets) {
	const family = Object.keys(FAMILIES).find((f) => FAMILIES[f]?.sets.test(set));
	if (!family) throw new Error(`No family for the texture set ${set}`);
	const maps: Record<string, string> = {};
	for (const file of readdirSync(join(ROOT, materialDir, set)).sort()) {
		const key = MAP_KEYS[file.replace(/^.*_1K-JPG_/, '').replace(/\.jpg$/, '')];
		if (key) maps[key] = `${materialDir}/${set}/${file}`;
	}
	const metresPerRepeat = REPEAT.find(([re]) => re.test(set))?.[1] ?? FAMILIES[family]?.metresPerRepeat ?? 3;
	for (let t = 0; t < TINTS; t++) {
		const tint = t === 0 ? [1, 1, 1] : [0, 1, 2].map(() => fixed(between(0.78, 1), 2));
		byFamily[family]?.push(materials.length);
		materials.push({ set, family, maps, tint, metresPerRepeat });
	}
}
// Each family deals its materials in a shuffled order, round after round, so every one is used.
const dealt: Record<string, number> = {};
for (const list of Object.values(byFamily)) {
	for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[list[i], list[j]] = [list[j] as number, list[i] as number];
	}
}
function material(family: string): number {
	const list = byFamily[family] ?? [];
	const n = dealt[family] ?? 0;
	dealt[family] = n + 1;
	return list[n % list.length] as number;
}

// Objects, stored by row.
const FIELDS = ['model', 'material', 'building', 'x', 'y', 'z', 'rotationY', 'sx', 'sy', 'sz'] as const;
const rows: number[][] = [];
const streetLights: [number, number][] = [];
const buildingHeights: { building: number; object: number; height: number }[] = [];
let buildings = 0;

const tileX = (i: number) => (i - (SIDE - 1) / 2) * TILE;

function place(m: number, x: number, z: number, rotationY = 0, scale = 1, y = 0, building = -1) {
	rows.push([m, -1, building, fixed(x, 2), fixed(y, 2), fixed(z, 2), fixed(rotationY, 4), scale, scale, scale]);
	return rows.length - 1;
}

function box(mat: number, x: number, z: number, w: number, h: number, d: number, y = 0, building = -1) {
	rows.push([-1, mat, building, fixed(x, 2), fixed(y, 2), fixed(z, 2), 0, fixed(w, 2), fixed(h, 2), fixed(d, 2)]);
	return rows.length - 1;
}

/** A tower of boxes: a base, tiers that step in, a roof slab and plant on the roof. */
function tower(x: number, z: number, size: number, height: number) {
	const id = buildings++;
	const base = between(4, 8);
	let w = size * between(0.75, 0.95);
	let d = size * between(0.75, 0.95);
	box(material('wall'), x, z, w, base, d, 0, id);
	let y = base;
	const tiers = height > 60 ? 3 : height > 25 ? 2 : 1;
	const wall = material('wall');
	let top = 0;
	for (let t = 0; t < tiers; t++) {
		const h = ((height - base) / tiers) * between(0.8, 1.2);
		w *= t === 0 ? 0.95 : between(0.7, 0.9);
		d *= t === 0 ? 0.95 : between(0.7, 0.9);
		top = box(chance(0.7) ? wall : material('wall'), x, z, w, h, d, y, id);
		y += h;
	}
	box(material('roof'), x, z, w * 0.96, 0.6, d * 0.96, y, id);
	for (let u = Math.floor(between(1, 5)); u > 0; u--) {
		const s = between(2, 4);
		box(material('roof'), x + between(-0.3, 0.3) * w, z + between(-0.3, 0.3) * d, s, between(1.5, 3), s, y + 0.6, id);
	}
	buildingHeights.push({ building: id, object: top, height: y });
}

/** A kit building at the lot's centre, turned to face the street, with props from its kit. */
function kitBuilding(kit: Kit, prefix: string, x: number, z: number, facing: number) {
	const id = buildings++;
	const m = model(kit, pick(kitNames(kit, prefix)));
	place(m, x, z, facing, KIT_SCALE, 0, id);
	return { id, height: modelSize[m]?.[1] ?? 0 };
}

const commercialDetails = ['detail-awning', 'detail-awning-wide', 'detail-overhang', 'detail-parasol-a', 'detail-parasol-b'];
const industrialProps = ['shipping-container-a', 'shipping-container-b', 'shipping-container-c', 'detail-tank', 'detail-tank-large', 'chimney-large'];

function lot(district: string, cx: number, cz: number, facing: number) {
	const half = (LOT * TILE) / 2;
	const near = (spread: number) => [cx + between(-spread, spread) * half, cz + between(-spread, spread) * half] as const;
	if (district === 'downtown') {
		tower(cx, cz, LOT * TILE * 0.85, between(45, 130));
		for (let i = 0; i < 4; i++) place(model('commercial', pick(commercialDetails)), ...near(0.9), facing, KIT_SCALE);
	} else if (district === 'midtown') {
		if (chance(0.5)) tower(cx, cz, LOT * TILE * 0.8, between(15, 40));
		else kitBuilding('commercial', chance(0.2) ? 'building-skyscraper' : 'building-', cx, cz, facing);
		for (let i = 0; i < 4; i++) place(model('commercial', pick(commercialDetails)), ...near(0.9), facing, KIT_SCALE);
		place(model('roads', 'dumpster'), ...near(0.9), facing, KIT_SCALE);
	} else if (district === 'industrial') {
		const { id, height } = kitBuilding('industrial', 'building-', cx, cz, facing);
		for (let i = Math.floor(between(1, 4)); i > 0; i--) {
			place(model('industrial', pick(['solar-panel-flat', 'chimney-small', 'chimney-medium'])), ...near(0.3), facing, KIT_SCALE, height, id);
		}
		for (let i = 0; i < 6; i++) place(model('industrial', pick(industrialProps)), ...near(0.95), facing + pick([0, Math.PI / 2]), KIT_SCALE);
		if (chance(0.1)) place(model('industrial', 'water-tower'), ...near(0.8), 0, KIT_SCALE);
	} else {
		kitBuilding('suburban', 'building-type-', cx, cz, facing);
		for (let i = 0; i < 6; i++) place(model('suburban', pick(['fence-1x2', 'fence-1x3', 'fence-2x2', 'fence-low'])), ...near(0.95), facing + pick([0, Math.PI / 2]), KIT_SCALE);
		place(model('suburban', pick(['driveway-long', 'driveway-short'])), ...near(0.6), facing, KIT_SCALE);
		place(model('suburban', pick(['path-long', 'path-stones-long', 'path-stones-short'])), ...near(0.6), facing, KIT_SCALE);
		for (let i = 0; i < 3; i++) place(model('suburban', pick(['tree-large', 'tree-small', 'planter'])), ...near(0.9), between(0, Math.PI * 2), KIT_SCALE);
	}
}

// Blocks: districts by distance from the centre; industry fills one corner of the outer ring.
for (let bx = 0; bx < BLOCKS; bx++) {
	for (let bz = 0; bz < BLOCKS; bz++) {
		const centre = (BLOCKS - 1) / 2;
		const distance = Math.hypot(bx - centre, bz - centre);
		const district =
			distance < 2 ? 'downtown' : distance < 3.6 ? 'midtown' : bx + bz < BLOCKS - 2 ? 'industrial' : 'suburban';
		const x0 = tileX(bx * PITCH + 1) - TILE / 2;
		const z0 = tileX(bz * PITCH + 1) - TILE / 2;
		const size = BLOCK_TILES * TILE;
		box(material('ground'), x0 + size / 2, z0 + size / 2, size, 0.15, size);
		for (let lx = 0; lx < BLOCK_TILES / LOT; lx++) {
			for (let lz = 0; lz < BLOCK_TILES / LOT; lz++) {
				const cx = x0 + (lx + 0.5) * LOT * TILE;
				const cz = z0 + (lz + 0.5) * LOT * TILE;
				const facing = Math.atan2(cx - (x0 + size / 2), cz - (z0 + size / 2));
				lot(district, cx, cz, quarterTurn(facing));
			}
		}
	}
}

// Roads: crossroads where two roads meet, straight tiles elsewhere, with lights, trees and signs.
for (let i = 0; i < SIDE; i++) {
	for (let j = 0; j < SIDE; j++) {
		const alongX = j % PITCH === 0;
		const alongZ = i % PITCH === 0;
		if (!alongX && !alongZ) continue;
		const x = tileX(i);
		const z = tileX(j);
		if (alongX && alongZ) {
			place(model('roads', 'road-crossroad'), x, z, 0, KIT_SCALE);
			const downtown = Math.hypot(x, z) < 2.5 * PITCH * TILE;
			for (let corner = 0; corner < 4; corner++) {
				const a = (corner * Math.PI) / 2;
				const name = downtown ? 'traffic-light' : pick(['road-sign-stop', 'road-sign-street', 'road-sign-warning']);
				place(model('roads', name), x + Math.cos(a) * 4.6, z + Math.sin(a) * 4.6, a, KIT_SCALE);
			}
			continue;
		}
		const rotation = alongZ ? 0 : Math.PI / 2;
		place(model('roads', 'road-straight'), x, z, rotation, KIT_SCALE);
		const k = alongZ ? j : i;
		const side = (k % 2 === 0 ? 1 : -1) * 5.6;
		const [ox, oz] = alongZ ? [side, 0] : [0, side];
		if (k % 2 === 0) {
			place(model('roads', pick(['light-curved', 'light-square'])), x + ox, z + oz, rotation + (side > 0 ? Math.PI : 0), KIT_SCALE);
			streetLights.push([x + ox, z + oz]);
			place(model('suburban', pick(['tree-large', 'tree-small'])), x - ox, z - oz, between(0, Math.PI * 2), KIT_SCALE);
		} else {
			place(model('suburban', pick(['tree-large', 'tree-small'])), x + ox, z + oz, between(0, Math.PI * 2), KIT_SCALE);
		}
		if (chance(0.04)) place(model('roads', pick(['construction-cone', 'construction-barrier'])), x - ox * 0.5, z - oz * 0.5, rotation, KIT_SCALE);
	}
}

// Camera: a closed loop along road centre lines that crosses the downtown blocks.
const road = (n: number) => tileX(n * PITCH);
const corners: [number, number][] = [
	[2, 2],
	[BLOCKS - 2, 2],
	[BLOCKS - 2, BLOCKS / 2],
	[BLOCKS / 2, BLOCKS / 2],
	[BLOCKS / 2, BLOCKS - 2],
	[2, BLOCKS - 2],
];
const path = corners.map(([a, b]) => [road(a), road(b)] as [number, number]);

// Lights: the street light nearest each of 32 points spaced evenly along the camera path.
const segments = path.map((p, i) => [p, path[(i + 1) % path.length] as [number, number]] as const);
const lengths = segments.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
const total = lengths.reduce((s, l) => s + l, 0);
const used = new Set<number>();
const lights: { position: number[]; color: number[]; intensity: number; range: number }[] = [];
for (let n = 0; n < LIGHTS; n++) {
	let distance = (n + 0.5) * (total / LIGHTS);
	let s = 0;
	while (distance > (lengths[s] as number)) distance -= lengths[s++] as number;
	const [a, b] = segments[s] as readonly [[number, number], [number, number]];
	const t = distance / (lengths[s] as number);
	const px = a[0] + (b[0] - a[0]) * t;
	const pz = a[1] + (b[1] - a[1]) * t;
	let best = -1;
	streetLights.forEach(([lx, lz], i) => {
		if (used.has(i)) return;
		const [bx, bz] = streetLights[best] ?? [Infinity, Infinity];
		if (Math.hypot(lx - px, lz - pz) < Math.hypot(bx - px, bz - pz)) best = i;
	});
	used.add(best);
	const [lx, lz] = streetLights[best] as [number, number];
	lights.push({ position: [fixed(lx, 2), 6.5, fixed(lz, 2)], color: [1, 0.82, 0.6], intensity: 400, range: 30 });
}

// Labels: the tallest towers, with names from two word lists.
const first = ['North', 'Harbour', 'Union', 'Market', 'River', 'Park', 'Station', 'Crown', 'Bridge', 'Garden'];
const second = ['Tower', 'House', 'Plaza', 'Building', 'Centre', 'Exchange'];
const names = new Set<string>();
const labels = [...buildingHeights]
	.sort((a, b) => b.height - a.height)
	.slice(0, LABELS)
	.map(({ building, object }) => {
		let text = '';
		while (!text || names.has(text)) text = `${pick(first)} ${pick(second)}`;
		names.add(text);
		return { building, object, text };
	});

const usedMaterials = new Set(rows.map((r) => r[1]).filter((m) => m !== undefined && m >= 0));
if (usedMaterials.size !== materials.length) {
	throw new Error(`The layout uses ${usedMaterials.size} of ${materials.length} materials`);
}

const out = process.argv[2];
if (!out) throw new Error('Usage: bun scripts/city.ts <output folder> [--seed <n>]');
const head = {
	generator: 'scripts/city.ts',
	seed: SEED,
	units: 'metres',
	up: '+Y',
	size: [SIDE * TILE, SIDE * TILE],
	counts: { objects: rows.length, buildings, models: models.length, materials: materials.length, lights: lights.length },
	models,
	materials,
	lights,
	camera: { height: 8, speed: 12, closed: true, path },
	labels,
};
const headText = JSON.stringify(head, null, '\t').replace(/\n}$/, '');
const body = rows.map((r) => `\t\t\t${JSON.stringify(r)}`).join(',\n');
const text = `${headText},\n\t"objects": {\n\t\t"fields": ${JSON.stringify(FIELDS)},\n\t\t"rows": [\n${body}\n\t\t]\n\t}\n}\n`;
JSON.parse(text);
await Bun.write(join(out, 'layout.json'), text);
console.log(`city: ${rows.length} objects, ${buildings} buildings, ${models.length} models, ${materials.length} materials`);
