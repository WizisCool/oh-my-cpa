import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react';

/**
 * Text files attached to an Agent message (ADR 0074).
 *
 * A file travels inside the message itself, as a `<file name="...">` block after the operator's
 * words: the server stores one string per message and resumes a turn from what it stored, so
 * anything that is not part of that string would be gone when a turn waiting on an approval
 * continues. That is also why only text is taken - an image has no such form.
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

/** assistant-ui's attachment adapter over those rules; a file is read once, when it is added. */
export class AgentTextFileAdapter implements AttachmentAdapter {
  // Any file may be offered: what decides is whether its bytes are text, which an extension or a
  // declared type cannot tell - a Dockerfile has neither - and a refusal the adapter makes is one
  // the operator is told about.
  readonly accept = '*';
  private readonly blocks = new Map<string, { block: string; bytes: number }>();
  private readonly onInvalid: () => void;

  constructor(onInvalid: () => void) {
    this.onInvalid = onInvalid;
  }

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    const attached = [...this.blocks.values()].reduce((total, entry) => total + entry.bytes, 0);
    const text = file.size > MAX_ATTACHED_BYTES ? undefined : decodeAttachedText(new Uint8Array(await file.arrayBuffer()));
    if (text === undefined || !text.trim() || this.blocks.size >= MAX_ATTACHED_FILES || attached + file.size > MAX_ATTACHED_BYTES) {
      this.onInvalid();
      throw new Error('invalid_attachment');
    }
    const id = `file-${Date.now().toString(36)}-${this.blocks.size}-${Math.random().toString(36).slice(2, 8)}`;
    this.blocks.set(id, { block: attachedFileBlock(file.name, text), bytes: file.size });
    return { id, type: 'document', name: file.name, contentType: file.type || 'text/plain', file, status: { type: 'requires-action', reason: 'composer-send' } };
  }

  async remove(attachment: { id: string }): Promise<void> {
    this.blocks.delete(attachment.id);
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const entry = this.blocks.get(attachment.id);
    this.blocks.delete(attachment.id);
    if (!entry) throw new Error('invalid_attachment');
    return { ...attachment, status: { type: 'complete' }, content: [{ type: 'text', text: entry.block }] };
  }
}
