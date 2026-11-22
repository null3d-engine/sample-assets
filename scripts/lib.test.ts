// Tests the reading of picture sizes, which the check holds to the texture size limit.
//
//   bun test scripts
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageSize, ROOT } from './lib.ts';

/** A WebP file's first 30 bytes: the RIFF header, the WEBP form and one chunk's start. */
function webp(chunk: string, body: number[]): Uint8Array {
	const b = new Uint8Array(30);
	b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
	b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
	b.set([...chunk].map((c) => c.charCodeAt(0)), 12);
	b.set(body, 20);
	return b;
}

test('reads a lossy WebP picture (VP8)', () => {
	// The frame tag, the start code, then 640 and 480 as 14-bit values with no scaling.
	const size = imageSize(webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]));
	expect(size).toEqual({ width: 640, height: 480 });
});

test('reads a lossless WebP picture (VP8L)', () => {
	// The signature, then the width less one and the height less one in 14 bits each.
	const bits = (100 - 1) | ((50 - 1) << 14);
	const size = imageSize(webp('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24]));
	expect(size).toEqual({ width: 100, height: 50 });
});

test('reads an extended WebP picture (VP8X) past the texture limit', () => {
	// The flags and three reserved bytes, then the canvas's width less one and height less one in
	// 24 bits each: 3000 x 2049, which the check must see as over 2048.
	const w = 3000 - 1;
	const h = 2049 - 1;
	const size = imageSize(
		webp('VP8X', [0, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, w >> 16, h & 0xff, (h >> 8) & 0xff, h >> 16]),
	);
	expect(size).toEqual({ width: 3000, height: 2049 });
});

test("reads the Creek statue's Tripo3D preview, a WebP file", () => {
	const b = readFileSync(join(ROOT, 'sources/showcase/creek-raw/statue/preview.webp'));
	const size = imageSize(new Uint8Array(b));
	expect(size).not.toBeNull();
	expect(size?.width).toBeGreaterThan(0);
	expect(size?.height).toBeGreaterThan(0);
});
