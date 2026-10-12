/**
 * The sharded Sarasa Mono SC beyond its core shard.
 *
 * `index.css` declares only the core shard of each weight, so the first frame waits for one
 * small file. The other shards are registered here, from an asynchronous chunk, with their
 * `unicode-range`; a browser downloads one only when a page draws a character it holds, such
 * as a rare character in an Agent answer. How the font is cut is described in `scripts/font-shards.mjs`.
 */
import manifest from '../assets/fonts/sarasa/manifest.json';
import { SHARD_URLS } from '../assets/fonts/sarasa/shardUrls';
import { shardsForText } from './fontShards';
import type { FontShard } from './fontShards';

type FontWeight = keyof typeof manifest.local;

function shardURL(weight: number, shard: FontShard): string {
  const url = SHARD_URLS[`${weight}-${shard.name}`];
  if (!url) throw new Error(`Font shard ${weight}-${shard.name} is missing`);
  return url;
}

function localSources(weight: number): string {
  return manifest.local[String(weight) as FontWeight].map((name) => `local("${name}")`).join(', ');
}

let isRegistered = false;

/** Adds every shard but the core to the document's fonts; none is fetched until it is drawn. */
export function registerDeferredShards(fonts: FontFaceSet = document.fonts): void {
  if (isRegistered) return;
  isRegistered = true;
  for (const weight of manifest.weights) {
    for (const shard of manifest.shards.slice(1)) {
      fonts.add(new FontFace(manifest.family, `${localSources(weight)}, url("${shardURL(weight, shard)}") format("woff2")`, {
        weight: String(weight),
        style: 'normal',
        display: 'swap',
        unicodeRange: shard.unicodeRange,
      }));
    }
  }
}

function readDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Fetched per export rather than kept: the shards are immutable, hashed files the HTTP cache
// already holds, and a page-lifetime copy of every exported shard would only grow.
async function embeddedShard(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Snapshot font unavailable');
  return readDataURL(new Blob([await response.arrayBuffer()], { type: 'font/woff2' }));
}

/**
 * Self-contained `@font-face` rules for a document that leaves the console: only the shards
 * its text draws, embedded as data URLs, so a short conversation carries a few hundred KiB
 * of font rather than the whole typeface.
 */
export async function embeddedFontCSS(text: string, family: string): Promise<string> {
  const shards = shardsForText(text, manifest.shards);
  const faces = await Promise.all(manifest.weights.flatMap((weight) => shards.map(async (shard) =>
    `@font-face{font-family:"${family}";src:url("${await embeddedShard(shardURL(weight, shard))}") format("woff2");font-weight:${weight};font-style:normal;unicode-range:${shard.unicodeRange}}`)));
  return faces.join('');
}
