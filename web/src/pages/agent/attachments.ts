import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react';
import { IMAGE_TYPES, MAX_IMAGES, readAgentImage } from '../playground/state';

/**
 * What an Agent message can carry beside its words.
 *
 * A text file travels inside the message itself, as a `<file name="...">` block after the
 * operator's words (ADR 0074): the server stores one string per message and resumes a turn from
 * what it stored. An image has no such form, so it travels beside the message as bytes, and the
 * server keeps it next to the conversation for as long as its turn lasts (ADR 0075).
 */
/** Every file of one message together; with the operator's words it stays under the server's message limit. */
export const MAX_ATTACHED_BYTES = 40 << 10;
export const MAX_ATTACHED_FILES = 4;

export interface AttachedFile {
  name: string;
  /** Size of the content in UTF-8 bytes. */
  bytes: number;
}

const FILE_BLOCK = /\n*<file name="([^"\n]{1,120})">\n([\s\S]*?)\n<\/file>/g;

/** A name that cannot close the attribute it sits in or start a new line. */
export function attachedFileName(name: string): string {
  return name.replace(/["<>\r\n]/g, '_').slice(0, 120) || 'file';
}

export function attachedFileBlock(name: string, content: string): string {
  // The closing tag inside a file would end its block early and let the rest read as the message.
  return `<file name="${attachedFileName(name)}">\n${content.replace(/<\/file>/g, '<\\/file>')}\n</file>`;
}

/**
 * A sent message as the operator's words and the files that came with them; `blocks` is those
 * files exactly as they were sent, for a message that is edited and sent again.
 */
export function splitAttachedFiles(message: string): { text: string; files: AttachedFile[]; blocks: string } {
  const files: AttachedFile[] = [];
  const blocks: string[] = [];
  const text = message.replace(FILE_BLOCK, (block: string, name: string, content: string) => {
    files.push({ name, bytes: new TextEncoder().encode(content).length });
    blocks.push(block.trim());
    return '';
  });
  return { text: text.trim(), files, blocks: blocks.join('\n\n') };
}

/** Whether bytes are text a model can read: valid UTF-8 without the control bytes of a binary file. */
export function decodeAttachedText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * assistant-ui's attachment adapter over those rules. A file is read once, when it is added, so
 * what is sent is what was checked; a refusal is one the operator is told about.
 */
export class AgentAttachmentAdapter implements AttachmentAdapter {
  // Any file may be offered: whether it is text is decided by its bytes, which an extension or a
  // declared type cannot tell - a Dockerfile has neither.
  readonly accept = '*';
  private readonly blocks = new Map<string, { block: string; bytes: number }>();
  private readonly images = new Map<string, string>();
  private readonly onInvalid: (kind: 'image' | 'file') => void;

  constructor(onInvalid: (kind: 'image' | 'file') => void) {
    this.onInvalid = onInvalid;
  }

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    if (file.type.startsWith('image/')) return this.addImage(file);
    const attached = [...this.blocks.values()].reduce((total, entry) => total + entry.bytes, 0);
    const text = file.size > MAX_ATTACHED_BYTES ? undefined : decodeAttachedText(new Uint8Array(await file.arrayBuffer()));
    if (text === undefined || !text.trim() || this.blocks.size >= MAX_ATTACHED_FILES || attached + file.size > MAX_ATTACHED_BYTES) {
      this.onInvalid('file');
      throw new Error('invalid_attachment');
    }
    const id = `file-${Date.now().toString(36)}-${this.blocks.size}-${Math.random().toString(36).slice(2, 8)}`;
    this.blocks.set(id, { block: attachedFileBlock(file.name, text), bytes: file.size });
    return { id, type: 'document', name: file.name, contentType: file.type || 'text/plain', file, status: { type: 'requires-action', reason: 'composer-send' } };
  }

  private async addImage(file: File): Promise<PendingAttachment> {
    try {
      if (!IMAGE_TYPES.includes(file.type) || this.images.size >= MAX_IMAGES) throw new Error('invalid_image');
      const image = await readAgentImage(file);
      // Checked again after the read: two images dropped together are both read before either lands.
      if (this.images.size >= MAX_IMAGES) throw new Error('invalid_image');
      this.images.set(image.uid, image.url);
      return { id: image.uid, type: 'image', name: image.name, contentType: image.type, file, status: { type: 'requires-action', reason: 'composer-send' } };
    } catch (cause) {
      this.onInvalid('image');
      throw cause;
    }
  }

  async remove(attachment: { id: string }): Promise<void> {
    this.blocks.delete(attachment.id);
    this.images.delete(attachment.id);
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const image = this.images.get(attachment.id);
    const entry = this.blocks.get(attachment.id);
    this.images.delete(attachment.id);
    this.blocks.delete(attachment.id);
    if (image) return { ...attachment, status: { type: 'complete' }, content: [{ type: 'image', image, filename: attachment.name }] };
    if (!entry) throw new Error('invalid_attachment');
    return { ...attachment, status: { type: 'complete' }, content: [{ type: 'text', text: entry.block }] };
  }
}
