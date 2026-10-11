// Generates the battle soldier from Quaternius's Character Soldier, for the engine's Battle
// comparison with three.js. Run: bun scripts/battle-soldier.ts <output folder>
//
// The source holds a skinned body of five materials, a head and two shoulder pads that hang on
// joints, and fourteen weapons in the right hand. The battle draws tens of thousands of soldiers, so
// the soldier becomes:
// - one skinned body of one material, with each part's color as a vertex color. The head and the
//   shoulder pads join the body, bound fully to the joint they hang on, so they keep their place in
//   every pose;
// - the rifle (AK) as a mesh of its own on the right hand, with its colors as vertex colors: a weapon
//   that follows its joint, in both engines;
// - the four clips that the battle plays, renamed idle, run, shoot and die.
// Each vertex color's alpha holds its part's surface class (PART in lib.ts): cloth, skin, leather,
// metal or painted steel, which the engine's shaders read. New texture coordinates, projected along
// each vertex's main axis in the model's units, let a weave texture cover the model. The source's
// texture coordinates (it has no textures), the other weapons and the other clips go.
// The body's node transform is baked into its vertices and into the inverse bind matrices, so the
// mesh's points are at the soldier's true size and its node stands at the origin. The node takes the
// name Soldier.
// The output is the same bytes on every run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accessorValues, boxUvs, COMPONENT_BYTES as BYTES, COMPONENTS, PART, readGlb, writeGlb } from './lib.ts';

const SOURCE = 'sources/characters/quaternius-soldier/Character_Soldier.glb';
const OUTPUT = 'soldier.glb';
const BODY_NODE = 'Body';
const FOLDED = ['Head', 'ShoulderPad.L', 'ShoulderPad.R'];
const WEAPON = 'AK';
const CLIPS: Record<string, string> = {
	idle: 'CharacterArmature|Idle',
	run: 'CharacterArmature|Run_Gun',
	shoot: 'CharacterArmature|Idle_Shoot',
	die: 'CharacterArmature|Death',
};
const BODY_MATERIAL = { name: 'Soldier', metallicFactor: 0, roughnessFactor: 0.8 };
/** Each source material's surface class; the uniform's green is painted steel on the helmet. */
const CLASSES: Record<string, number> = {
	Skin: PART.skin,
	Black: PART.rubber,
	DarkGrey: PART.rubber,
	Wood: PART.rubber,
	Grey: PART.metal,
	Grey2: PART.metal,
	Character_Main: PART.cloth,
	Pants: PART.cloth,
};
/** Folded parts that are painted steel whatever their material: the helmet's head and the pads. */
const STEEL: Record<string, string[]> = { Head: ['Character_Main'], 'ShoulderPad.L': ['Grey'], 'ShoulderPad.R': ['Grey'] };
const WEAPON_MATERIAL = { name: 'Rifle', metallicFactor: 0.6, roughnessFactor: 0.45 };

// biome-ignore lint/suspicious/noExplicitAny: glTF JSON
type Json = any;
type Mat4 = Float64Array;

const root = join(import.meta.dir, '..');
const out = process.argv[2];
if (!out) throw new Error('Usage: bun scripts/battle-soldier.ts <output folder>');

// Reading the source.

const { json: gltf, bin } = readGlb(readFileSync(join(root, SOURCE)));
const read = (index: number) => accessorValues(gltf, bin, index);

// Matrices, column-major as glTF keeps them.

function compose(node: Json): Mat4 {
	const m = new Float64Array(16);
	if (node.matrix) {
		m.set(node.matrix);
		return m;
	}
	const [tx, ty, tz] = node.translation ?? [0, 0, 0];
	const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
	const [sx, sy, sz] = node.scale ?? [1, 1, 1];
	m[0] = (1 - 2 * (y * y + z * z)) * sx;
	m[1] = 2 * (x * y + z * w) * sx;
	m[2] = 2 * (x * z - y * w) * sx;
	m[4] = 2 * (x * y - z * w) * sy;
	m[5] = (1 - 2 * (x * x + z * z)) * sy;
	m[6] = 2 * (y * z + x * w) * sy;
	m[8] = 2 * (x * z + y * w) * sz;
	m[9] = 2 * (y * z - x * w) * sz;
	m[10] = (1 - 2 * (x * x + y * y)) * sz;
	m[12] = tx;
	m[13] = ty;
	m[14] = tz;
	m[15] = 1;
	return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
	const m = new Float64Array(16);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) sum += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
			m[c * 4 + r] = sum;
		}
	return m;
}

function invert(m: Mat4): Mat4 {
	// Gauss-Jordan on a 4 x 4 matrix, row by row in a working copy.
	const a = Array.from({ length: 4 }, (_, r) => [
		...Array.from({ length: 4 }, (_, c) => m[c * 4 + r] as number),
		...[0, 1, 2, 3].map((c) => (c === r ? 1 : 0)),
	]);
	for (let col = 0; col < 4; col++) {
		let pivot = col;
		for (let r = col + 1; r < 4; r++)
			if (Math.abs(a[r]?.[col] as number) > Math.abs(a[pivot]?.[col] as number)) pivot = r;
		[a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]];
		const row = a[col] as number[];
		const p = row[col] as number;
		for (let c = 0; c < 8; c++) row[c] = (row[c] as number) / p;
		for (let r = 0; r < 4; r++) {
			if (r === col) continue;
			const other = a[r] as number[];
			const f = other[col] as number;
			for (let c = 0; c < 8; c++) other[c] = (other[c] as number) - f * (row[c] as number);
		}
	}
	const inv = new Float64Array(16);
	for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) inv[c * 4 + r] = a[r]?.[c + 4] as number;
	return inv;
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
	return [
		(m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
		(m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
		(m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
	];
}

/** A normal turned by the matrix's inverse transpose, made unit length again. */
function transformNormal(m: Mat4, x: number, y: number, z: number): [number, number, number] {
	const t = invert(m);
	const nx = (t[0] as number) * x + (t[1] as number) * y + (t[2] as number) * z;
	const ny = (t[4] as number) * x + (t[5] as number) * y + (t[6] as number) * z;
	const nz = (t[8] as number) * x + (t[9] as number) * y + (t[10] as number) * z;
	const length = Math.hypot(nx, ny, nz) || 1;
	return [nx / length, ny / length, nz / length];
}

// The source's tree.

const nodes: Json[] = gltf.nodes;
const parentOf = new Int32Array(nodes.length).fill(-1);
nodes.forEach((node, i) => {
	for (const child of node.children ?? []) parentOf[child] = i;
});
const worldOf = (i: number): Mat4 => {
	const local = compose(nodes[i]);
	return parentOf[i] < 0 ? local : multiply(worldOf(parentOf[i] as number), local);
};
const nodeNamed = (name: string, withMesh: boolean): number => {
	const i = nodes.findIndex((n) => n.name === name && (n.mesh !== undefined) === withMesh);
	if (i < 0) throw new Error(`The source has no node ${name}`);
	return i;
};

const skin = gltf.skins[0];
const inverseBinds = read(skin.inverseBindMatrices);
const bodyNode = nodeNamed(BODY_NODE, true);
const weaponNode = nodeNamed(WEAPON, true);

// One mesh of one primitive from parts, each part's color a vertex color.

interface Built {
	position: number[];
	normal: number[];
	/** Four floats per vertex: the part's color, and its surface class in alpha. */
	color: number[];
	joints: number[];
	weights: number[];
	index: number[];
}

const built = (): Built => ({ position: [], normal: [], color: [], joints: [], weights: [], index: [] });

/**
 * Adds a mesh's primitives to `into`: points through `toPoint`, normals through `toNormal`, and
 * joints and weights from the primitive, or else all of the weight on `joint`.
 */
function addMesh(into: Built, mesh: Json, place: Mat4, joint: number | null): void {
	for (const primitive of mesh.primitives) {
		const name = gltf.materials[primitive.material]?.name as string;
		const part = STEEL[mesh.name]?.includes(name) ? PART.paint : CLASSES[name];
		if (part === undefined) throw new Error(`No surface class for material ${name}`);
		const base = into.position.length / 3;
		const position = read(primitive.attributes.POSITION);
		const normal = read(primitive.attributes.NORMAL);
		const factor = gltf.materials[primitive.material]?.pbrMetallicRoughness?.baseColorFactor ?? [
			1, 1, 1, 1,
		];
		const skinned = primitive.attributes.JOINTS_0 !== undefined;
		const joints = skinned ? read(primitive.attributes.JOINTS_0) : [];
		const weights = skinned ? read(primitive.attributes.WEIGHTS_0) : [];
		for (let v = 0; v < position.length / 3; v++) {
			into.position.push(
				...transformPoint(
					place,
					position[v * 3] as number,
					position[v * 3 + 1] as number,
					position[v * 3 + 2] as number,
				),
			);
			into.normal.push(
				...transformNormal(
					place,
					normal[v * 3] as number,
					normal[v * 3 + 1] as number,
					normal[v * 3 + 2] as number,
				),
			);
			into.color.push(factor[0], factor[1], factor[2], part);
			if (skinned) {
				into.joints.push(...joints.slice(v * 4, v * 4 + 4));
				into.weights.push(...weights.slice(v * 4, v * 4 + 4));
			} else if (joint !== null) {
				into.joints.push(joint, 0, 0, 0);
				into.weights.push(1, 0, 0, 0);
			}
		}
		for (const i of read(primitive.indices)) into.index.push(base + i);
	}
}

// The body: the skinned mesh in its node's frame, then the parts that hang on joints. The skin's
// bind space moves into the same frame, so skinning the baked points gives the source's pose.
const bake = worldOf(bodyNode);
const unbake = invert(bake);
const body = built();
addMesh(body, gltf.meshes[nodes[bodyNode].mesh], bake, null);
for (const name of FOLDED) {
	const part = nodeNamed(name, true);
	const bone = parentOf[part] as number;
	const joint = skin.joints.indexOf(bone);
	if (joint < 0) throw new Error(`${name} hangs on a node that is not a joint`);
	// The part's points in the skin's bind space: its joint's bind matrix times its place on the joint.
	const bind = invert(new Float64Array(inverseBinds.slice(joint * 16, joint * 16 + 16)));
	addMesh(body, gltf.meshes[nodes[part].mesh], multiply(bake, multiply(bind, compose(nodes[part]))), joint);
}
const bakedInverseBinds = skin.joints.flatMap((_: number, j: number) =>
	Array.from(multiply(new Float64Array(inverseBinds.slice(j * 16, j * 16 + 16)), unbake)),
);
// Each vertex's weights add up to one, as glTF asks.
for (let v = 0; v < body.weights.length / 4; v++) {
	let sum = 0;
	for (let k = 0; k < 4; k++) sum += body.weights[v * 4 + k] as number;
	for (let k = 0; k < 4; k++) body.weights[v * 4 + k] = (body.weights[v * 4 + k] as number) / sum;
}
const weapon = built();
addMesh(weapon, gltf.meshes[nodes[weaponNode].mesh], new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), null);

// The kept nodes: every node but the meshes that went into the body and the other weapons. The
// body's node moves to the scene's root, at the origin.

const handWeapons = new Set(
	nodes.flatMap((n, i) => (n.mesh !== undefined && parentOf[i] === parentOf[weaponNode] ? [i] : [])),
);
const dropped = new Set<number>([...FOLDED.map((name) => nodeNamed(name, true)), ...handWeapons]);
dropped.delete(weaponNode);
const kept = nodes.map((_, i) => i).filter((i) => !dropped.has(i));
const newIndex = new Int32Array(nodes.length).fill(-1);
kept.forEach((old, i) => {
	newIndex[old] = i;
});

// Writing the output: a fresh buffer of the new data and the kept clips' keys.

const chunks: Buffer[] = [];
let binLength = 0;
const bufferViews: Json[] = [];
const accessors: Json[] = [];

function addView(bytes: Buffer, target?: number): number {
	const pad = (4 - (binLength % 4)) % 4;
	if (pad) {
		chunks.push(Buffer.alloc(pad));
		binLength += pad;
	}
	bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.length, ...(target ? { target } : {}) });
	chunks.push(bytes);
	binLength += bytes.length;
	return bufferViews.length - 1;
}

function addAccessor(values: number[], type: string, componentType: number, target?: number, bounds = false): number {
	const bytes = Buffer.alloc(values.length * (BYTES[componentType] as number));
	values.forEach((value, i) => {
		if (componentType === 5126) bytes.writeFloatLE(value, i * 4);
		else if (componentType === 5125) bytes.writeUInt32LE(value, i * 4);
		else if (componentType === 5123) bytes.writeUInt16LE(value, i * 2);
		else bytes.writeUInt8(value, i);
	});
	const size = COMPONENTS[type] as number;
	const accessor: Json = {
		bufferView: addView(bytes, target),
		componentType,
		count: values.length / size,
		type,
	};
	if (bounds) {
		const min = Array.from({ length: size }, (_, c) =>
			Math.min(...values.filter((_, i) => i % size === c)),
		);
		const max = Array.from({ length: size }, (_, c) =>
			Math.max(...values.filter((_, i) => i % size === c)),
		);
		accessor.min = min.map((v) => Math.fround(v));
		accessor.max = max.map((v) => Math.fround(v));
	}
	accessors.push(accessor);
	return accessors.length - 1;
}

const ARRAY = 34962;
const ELEMENTS = 34963;

function primitiveOf(mesh: Built, material: number, skinned: boolean): Json {
	const attributes: Json = {
		POSITION: addAccessor(mesh.position, 'VEC3', 5126, ARRAY, true),
		NORMAL: addAccessor(mesh.normal, 'VEC3', 5126, ARRAY),
		COLOR_0: addAccessor(mesh.color, 'VEC4', 5126, ARRAY),
		TEXCOORD_0: addAccessor(boxUvs(mesh.position, mesh.normal), 'VEC2', 5126, ARRAY),
	};
	if (skinned) {
		attributes.JOINTS_0 = addAccessor(mesh.joints, 'VEC4', 5123, ARRAY);
		attributes.WEIGHTS_0 = addAccessor(mesh.weights, 'VEC4', 5126, ARRAY);
	}
	return { attributes, indices: addAccessor(mesh.index, 'SCALAR', 5123, ELEMENTS), material };
}

const meshes = [
	{ name: 'Soldier', primitives: [primitiveOf(body, 0, true)] },
	{ name: WEAPON, primitives: [primitiveOf(weapon, 1, false)] },
];
const materials = [BODY_MATERIAL, WEAPON_MATERIAL].map(({ name, metallicFactor, roughnessFactor }) => ({
	name,
	pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor, roughnessFactor },
}));

const outNodes = kept.map((old) => {
	const node = nodes[old];
	// The body's node takes the mesh's name, since a joint of the source is also named Body.
	const copy: Json = { name: old === bodyNode ? 'Soldier' : node.name };
	if (old !== bodyNode) {
		for (const key of ['translation', 'rotation', 'scale', 'matrix']) if (node[key]) copy[key] = node[key];
	}
	const children = (node.children ?? []).filter((c: number) => !dropped.has(c) && c !== bodyNode);
	if (children.length) copy.children = children.map((c: number) => newIndex[c]);
	if (old === bodyNode) {
		copy.mesh = 0;
		copy.skin = 0;
	}
	if (old === weaponNode) copy.mesh = 1;
	return copy;
});

const inverseBindAccessor = addAccessor(bakedInverseBinds, 'MAT4', 5126);
const skins = [
	{
		name: skin.name,
		inverseBindMatrices: inverseBindAccessor,
		joints: skin.joints.map((j: number) => newIndex[j]),
		...(skin.skeleton !== undefined ? { skeleton: newIndex[skin.skeleton] } : {}),
	},
];

const animations = Object.entries(CLIPS).map(([name, sourceName]) => {
	const clip = gltf.animations.find((a: Json) => a.name === sourceName);
	if (!clip) throw new Error(`The source has no clip ${sourceName}`);
	const samplers: Json[] = [];
	const channels: Json[] = [];
	for (const channel of clip.channels) {
		if (dropped.has(channel.target.node)) continue;
		const sampler = clip.samplers[channel.sampler];
		const input = gltf.accessors[sampler.input];
		const output = gltf.accessors[sampler.output];
		samplers.push({
			input: addAccessor(read(sampler.input), input.type, 5126, undefined, true),
			output: addAccessor(read(sampler.output), output.type, 5126),
			interpolation: sampler.interpolation ?? 'LINEAR',
		});
		channels.push({
			sampler: samplers.length - 1,
			target: { node: newIndex[channel.target.node], path: channel.target.path },
		});
	}
	return { name, channels, samplers };
});

const rootNodes = gltf.scenes[gltf.scene ?? 0].nodes.map((n: number) => newIndex[n]);
rootNodes.push(newIndex[bodyNode]);
const output: Json = {
	asset: { version: '2.0', generator: 'null3d sample-assets scripts/battle-soldier.ts' },
	scene: 0,
	scenes: [{ name: 'Soldier', nodes: rootNodes }],
	nodes: outNodes,
	meshes,
	materials,
	skins,
	animations,
	accessors,
	bufferViews,
	buffers: [{ byteLength: binLength }],
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, OUTPUT), writeGlb(output, Buffer.concat(chunks)));
console.log(
	`${OUTPUT}: ${body.index.length / 3} body triangles, ${weapon.index.length / 3} rifle triangles, ${kept.length} nodes, ${animations.length} clips`,
);
