import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react';
import { IMAGE_TYPES, MAX_IMAGES, readImage } from './state';

/**
 * The Playground's images, as assistant-ui's attachment adapter.
 *
 * Every image the composer takes - pasted, dropped or picked - passes the same checks the
 * Playground always applied: an allowed type whose bytes match it, within the size limit, and no
 * more than four per message. An image is read once, when it is added; sending hands on the data
 * URL that read produced, so a file changed on disk in between cannot slip past the checks.
 */
export class PlaygroundImageAdapter implements AttachmentAdapter {
  readonly accept = IMAGE_TYPES.join(',');
  private readonly urls = new Map<string, string>();

  constructor(
    private readonly countAttached: () => number,
    private readonly onInvalid: () => void,
  ) {}

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    try {
      if (this.countAttached() >= MAX_IMAGES) throw new Error('invalid_image');
      const image = await readImage(file);
      this.urls.set(image.uid, image.url);
      return { id: image.uid, type: 'image', name: image.name, contentType: image.type, file, status: { type: 'requires-action', reason: 'composer-send' } };
    } catch (cause) {
      this.onInvalid();
      throw cause;
    }
  }

  async remove(attachment: { id: string }): Promise<void> {
    this.urls.delete(attachment.id);
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const url = this.urls.get(attachment.id);
    this.urls.delete(attachment.id);
    if (!url) throw new Error('invalid_image');
    return { ...attachment, status: { type: 'complete' }, content: [{ type: 'image', image: url, filename: attachment.name }] };
  }
}
