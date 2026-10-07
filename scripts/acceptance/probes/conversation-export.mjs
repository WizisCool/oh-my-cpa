import fs from 'node:fs/promises';
import path from 'node:path';
import { until } from '../harness.mjs';

/** Exercise the real download, then the standalone reader without the application renderer. */
export async function checkConversationExport({ page, check, kind, expectedText }) {
  const directory = path.resolve('tmp/conversation-export');
  await fs.mkdir(directory, { recursive: true });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const htmlDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Conversation HTML', exact: true }).click();
  const download = await htmlDownload;
  const htmlPath = path.join(directory, `${kind}.html`);
  await download.saveAs(htmlPath);
  const html = await fs.readFile(htmlPath, 'utf8');
  check(`${kind} offers a single-file HTML conversation instead of a Markdown download`, download.suggestedFilename().endsWith('.html') && html.includes('data:font/woff2;base64,') && html.includes(expectedText));
  const standalone = await page.context().newPage();
  try {
    await standalone.setViewportSize({ width: 1440, height: 900 });
    await standalone.setContent(html, { waitUntil: 'load' });
    await standalone.evaluate(() => document.fonts.ready);
    await standalone.locator('.answer').first().waitFor();
    const layout = await standalone.evaluate(() => {
      const column = document.querySelector('.transcript-column');
      const bubble = document.querySelector('.user');
      const answer = document.querySelector('.answer');
      return { columnWidth: column.getBoundingClientRect().width, bubbleRight: bubble.getBoundingClientRect().right, answerRight: answer.getBoundingClientRect().right,
        panelHidden: document.querySelector('.aside').hidden, background: getComputedStyle(document.body).backgroundColor };
    });
    check(`${kind} HTML keeps the workspace reading column, right-aligned user bubble and quiet closed panel`, layout.columnWidth === 808 && Math.abs(layout.bubbleRight - layout.answerRight) < 2 && layout.panelHidden, JSON.stringify(layout));
    await standalone.screenshot({ path: path.join(directory, `${kind}-html.png`) });
    await standalone.getByRole('button', { name: 'Side panel', exact: true }).first().click();
    await standalone.getByRole('button', { name: 'Expand details', exact: true }).click();
    check(`${kind} standalone disclosure controls work locally`, await standalone.locator('.turn details:not([open])').count() === 0);
    await standalone.getByRole('button', { name: 'Collapse details', exact: true }).click();
    check(`${kind} standalone details can close again`, await standalone.locator('.turn details[open]').count() === 0);
    await standalone.getByRole('button', { name: 'Close', exact: true }).click();
    await standalone.getByRole('button', { name: 'Search conversation', exact: true }).click();
    await standalone.getByRole('searchbox', { name: 'Search conversation' }).fill('not-present-export-fixture');
    check(`${kind} standalone search hides nonmatching turns`, await standalone.locator('.turn:not([hidden])').count() === 0);
    await standalone.getByRole('searchbox', { name: 'Search conversation' }).fill('');
    await standalone.keyboard.press('Escape');
    check(`${kind} standalone search can restore the transcript`, await standalone.locator('.turn:not([hidden])').count() > 0);
    const copy = standalone.locator('.message-foot [data-copy]').first();
    await copy.click();
    // The label returns to "Copy" on its own, so the outcome is read from the state the label follows.
    const outcome = await until(async () => await copy.getAttribute('data-state'), { label: 'standalone clipboard outcome' });
    check(`${kind} standalone copy reports its outcome`, outcome === 'copied', String(outcome));
    await standalone.setViewportSize({ width: 375, height: 812 });
    const fits = await standalone.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.transcript').scrollWidth <= innerWidth);
    check(`${kind} standalone workspace fits a phone`, fits);
    await standalone.screenshot({ path: path.join(directory, `${kind}-html-phone.png`) });
  } finally { await standalone.close(); }
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const imageDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Conversation image (PNG)', exact: true }).click();
  const image = await imageDownload;
  const imagePath = path.join(directory, `${kind}.png`);
  await image.saveAs(imagePath);
  const bytes = await fs.readFile(imagePath);
  const evidence = await page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let opaque = 0; const colors = new Set();
    for (let i = 0; i < pixels.length; i += 64) { if (pixels[i + 3] === 255) opaque++; colors.add(`${pixels[i]}-${pixels[i + 1]}-${pixels[i + 2]}`); }
    return { width: image.width, height: image.height, opaque, colors: colors.size };
  }, bytes.toString('base64'));
  check(`${kind} image export produces a painted, opaque high-resolution conversation`, image.suggestedFilename().endsWith('.png') && evidence.width === 1680 && evidence.height > 500 && evidence.opaque > 1000 && evidence.colors > 20, JSON.stringify(evidence));
  check(`${kind} image capture removes its temporary document`, await page.locator('iframe[sandbox="allow-same-origin"]').count() === 0);
}
