// Generates the battle mech from George as the old demos repository converted it
// (characters/quaternius-mech), for the engine's Battle comparison with three.js.
// Run: bun scripts/battle-mech.ts <output folder>
//
// The mesh, its skin and its clips stay as they are. Two things change on each primitive:
// - each vertex color takes its part's surface class (PART in lib.ts) in alpha, which the engine's
//   shaders read: the green and rust armor is painted steel, the greys are bare metal, and the black
//   parts are glowing vents on the body and rubber on the legs;
// - new texture coordinates, projected along each vertex's main axis in the model's units, let a
//   texture of armor panels cover the model.
// The source's own color accessor stays in the file, unused, so the source's data is copied as it is.
// The output is the same bytes on every run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accessorValues, boxUvs, PART, readGlb, writeGlb } from './lib.ts';

const SOURCE = 'sources/characters/quaternius-mech/mech.glb';
const OUTPUT = 'mech.glb';
/** The part colors of the source, linear, and each one's class. */
const PALETTE: { color: [number, number, number]; part: number }[] = [
	{ color: [0.136, 0.24, 0.167], part: PART.paint },
	{ color: [0.292, 0.122, 0.028], part: PART.paint },
	{ color: [0.157, 0.157, 0.157], part: PART.metal },
	{ color: [0.288, 0.288, 0.288], part: PART.metal },
	{ color: [0.024, 0.024, 0.024], part: PART.glow },
];
/** Black parts below this height, in the model's units, are rubber on the legs, not vents. */
const VENTS_ABOVE = 3.2;

const root = join(import.meta.dir, '..');
const out = process.argv[2];
if (!out) throw new Error('Usage: bun scripts/battle-mech.ts <output folder>');

const { json, bin } = readGlb(readFileSync(join(root, SOURCE)));
const added: Buffer[] = [bin];
let length = bin.length;

/** Appends float values as a new accessor after the source's data, and returns its index. */
function addFloats(values: number[], type: 'VEC2' | 'VEC4'): number {
	const pad = (4 - (length % 4)) % 4;
	added.push(Buffer.alloc(pad));
	length += pad;
	const bytes = Buffer.alloc(values.length * 4);
	values.forEach((value, i) => {
		bytes.writeFloatLE(value, i * 4);
	});
	json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target: 34962 });
	added.push(bytes);
	length += bytes.length;
	json.accessors.push({
		bufferView: json.bufferViews.length - 1,
		componentType: 5126,
		count: values.length / (type === 'VEC2' ? 2 : 4),
		type,
	});
	return json.accessors.length - 1;
}

for (const mesh of json.meshes)
	for (const primitive of mesh.primitives) {
		const position = accessorValues(json, bin, primitive.attributes.POSITION);
		const normal = accessorValues(json, bin, primitive.attributes.NORMAL);
		const source = accessorValues(json, bin, primitive.attributes.COLOR_0);
		const channels = source.length / (position.length / 3);
		const color: number[] = [];
		for (let v = 0; v < position.length / 3; v++) {
			const c = source.slice(v * channels, v * channels + 3) as [number, number, number];
			const nearest = PALETTE.reduce((best, entry) =>
				Math.hypot(...entry.color.map((x, k) => x - c[k])) <
				Math.hypot(...best.color.map((x, k) => x - c[k]))
					? entry
					: best,
			);
			const low = (position[v * 3 + 1] as number) < VENTS_ABOVE;
			color.push(...c, nearest.part === PART.glow && low ? PART.rubber : nearest.part);
		}
		primitive.attributes.COLOR_0 = addFloats(color, 'VEC4');
		primitive.attributes.TEXCOORD_0 = addFloats(boxUvs(position, normal), 'VEC2');
	}
json.asset = { ...json.asset, generator: 'null3d sample-assets scripts/battle-mech.ts' };

mkdirSync(out, { recursive: true });
writeFileSync(join(out, OUTPUT), writeGlb(json, Buffer.concat(added)));
console.log(`${OUTPUT}: ${json.meshes.length} mesh, surface classes and texture coordinates added`);
