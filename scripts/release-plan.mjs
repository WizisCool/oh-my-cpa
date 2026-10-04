import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareReleaseTags(first, second) {
  const firstParts = STABLE_TAG.exec(first);
  const secondParts = STABLE_TAG.exec(second);
  if (!firstParts || !secondParts) throw new Error('Expected stable vMAJOR.MINOR.PATCH tags');
  for (let i = 1; i <= 3; i++) {
    const firstNumber = BigInt(firstParts[i]);
    const secondNumber = BigInt(secondParts[i]);
    if (firstNumber !== secondNumber) return firstNumber > secondNumber ? 1 : -1;
  }
  return 0;
}

export function createReleasePlan({ tag, packageVersion, webVersion, image, releases = [] }) {
  if (!STABLE_TAG.test(tag ?? '')) throw new Error('Release tags must be stable vMAJOR.MINOR.PATCH versions');
  const version = tag.slice(1);
  if (version !== packageVersion || version !== webVersion) throw new Error('Tag must match both package.json versions');
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(image ?? '')) {
    throw new Error('Docker Hub image must be a lowercase namespace/repository');
  }
  // A backport can publish a versioned image, but cannot move either latest pointer backwards.
  const isLatest = !releases.some((release) => !release.draft && !release.prerelease
    && STABLE_TAG.test(release.tag_name) && compareReleaseTags(release.tag_name, tag) > 0);
  return {
    tag, version, image, isLatest,
    tags: [`${image}:${tag}`, `${image}:${version}`, ...(isLatest ? [`${image}:latest`] : [])],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const plan = createReleasePlan({
    tag: process.env.RELEASE_TAG,
    image: process.env.RELEASE_IMAGE ?? 'wiziscool/oh-my-cpa',
    packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    webVersion: JSON.parse(fs.readFileSync(path.join(root, 'web/package.json'), 'utf8')).version,
    releases: process.env.RELEASE_INDEX ? JSON.parse(fs.readFileSync(process.env.RELEASE_INDEX, 'utf8')) : [],
  });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${plan.tag}\nversion=${plan.version}\nimage=${plan.image}\nis_latest=${plan.isLatest}\nversion_tags=${plan.tags.slice(0, 2).join(',')}\ntags=${plan.tags.join(',')}\n`);
  }
  console.log(JSON.stringify(plan, null, 2));
}
