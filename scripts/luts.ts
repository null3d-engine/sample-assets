// Writes the colour grading tables: an identity table and two looks, warm and cool, each as a
// .cube file (33 points per side, red changing fastest) and as a .3dl file (17 points per side,
// 12-bit integers, blue changing fastest). The same input always gives the same bytes.
//
//   bun scripts/luts.ts <output folder>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Rgb = [number, number, number];

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const luma = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const LOOKS: Record<string, { title: string; grade: (c: Rgb) => Rgb }> = {
	identity: { title: 'Identity', grade: (c) => c },
	// Warmer whites and slightly lifted shadows.
	warm: {
		title: 'Warm',
		grade: ([r, g, b]) => [clamp(0.02 + r ** 0.95 * 1.04), clamp(0.01 + g * 1.01), clamp(b ** 1.05 * 0.9)],
	},
	// More contrast, a blue cast and less saturation.
	cool: {
		title: 'Cool',
		grade: (c) => {
			const contrast = c.map((x) => clamp((x - 0.5) * 1.15 + 0.5)) as Rgb;
			const y = luma(contrast);
			const [r, g, b] = contrast.map((x) => y + (x - y) * 0.85);
			return [clamp(r * 0.94), clamp(g * 0.99), clamp(b * 1.06)];
		},
	},
};

function cube(title: string, grade: (c: Rgb) => Rgb, size: number): string {
	const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				const out = grade([r / (size - 1), g / (size - 1), b / (size - 1)]);
				lines.push(out.map((x) => x.toFixed(5)).join(' '));
			}
		}
	}
	return `${lines.join('\n')}\n`;
}

function threeDl(grade: (c: Rgb) => Rgb, size: number): string {
	const shaper = Array.from({ length: size }, (_, i) => Math.round((i * 1023) / (size - 1)));
	const lines = [shaper.join(' ')];
	for (let r = 0; r < size; r++) {
		for (let g = 0; g < size; g++) {
			for (let b = 0; b < size; b++) {
				const out = grade([r / (size - 1), g / (size - 1), b / (size - 1)]);
				lines.push(out.map((x) => Math.round(x * 4095)).join(' '));
			}
		}
	}
	return `${lines.join('\n')}\n`;
}

const out = process.argv[2];
if (!out) throw new Error('Usage: bun scripts/luts.ts <output folder>');
mkdirSync(out, { recursive: true });
for (const [name, look] of Object.entries(LOOKS)) {
	await Bun.write(join(out, `${name}.cube`), cube(look.title, look.grade, 33));
	await Bun.write(join(out, `${name}.3dl`), threeDl(look.grade, 17));
}
