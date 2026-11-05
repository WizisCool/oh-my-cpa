import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Model Square ships models.dev reference data in the binary and never fetches it at runtime,
// so a release is the only point where that data can advance. Measured against the release
// commit's date rather than the clock, a rerun of the same tag reaches the same verdict.
export const MAX_MODEL_METADATA_AGE_DAYS = 30;

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

export function assertModelMetadataCurrent(metadataUpdatedAt, revisionDate) {
  if (!ISO_DATE.test(metadataUpdatedAt ?? '') || !ISO_DATE.test(revisionDate ?? '')) throw new Error('Expected YYYY-MM-DD model metadata and revision dates');
  const ageDays = (Date.parse(revisionDate) - Date.parse(metadataUpdatedAt)) / 86_400_000;
  if (!(ageDays <= MAX_MODEL_METADATA_AGE_DAYS)) {
    throw new Error(`models.dev snapshot ${metadataUpdatedAt} is more than ${MAX_MODEL_METADATA_AGE_DAYS} days older than the release commit; run pnpm models:sync`);
  }
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
  assertModelMetadataCurrent(
    JSON.parse(fs.readFileSync(path.join(root, 'internal/modelcatalog/snapshot.json'), 'utf8')).updated_at,
    execFileSync('git', ['log', '-1', '--format=%cs', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  );
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
