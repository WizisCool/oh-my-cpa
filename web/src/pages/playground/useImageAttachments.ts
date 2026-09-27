import React from 'react';
import { MAX_IMAGES, readImage } from './state';
import type { ImageAttachment } from './state';

export interface ImageAttachments {
  images: ImageAttachment[];
  /** Images still being read and validated; a send waits for them. */
  pendingCount: number;
  add: (files: FileList | File[]) => void;
  remove: (uid: string) => void;
  /** Drops every image, including reads still in flight. */
  clear: () => void;
  /** Takes the attached images for a message and empties the tray. */
  take: () => ImageAttachment[];
}

/**
 * The pasted images waiting to go out with the next message.
 *
 * Reads are serialised so the four-image limit is checked against what has actually been
 * accepted, and each read carries the generation it started in: clearing the tray (a new
 * conversation, a sent message) bumps the generation, so a slow read that lands afterwards is
 * discarded instead of attaching itself to the wrong message.
 */
export function useImageAttachments(onInvalid: () => void): ImageAttachments {
  const [images, setImages] = React.useState<ImageAttachment[]>([]);
  const [pendingCount, setPendingCount] = React.useState(0);
  const imagesRef = React.useRef<ImageAttachment[]>([]);
  const queueRef = React.useRef(Promise.resolve());
  const generationRef = React.useRef(0);
  const isMountedRef = React.useRef(true);
  const onInvalidRef = React.useRef(onInvalid);
  onInvalidRef.current = onInvalid;

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      imagesRef.current = [];
    };
  }, []);

  const commit = React.useCallback((next: ImageAttachment[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);

  const add = React.useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const generation = generationRef.current;
      const isCurrent = () => isMountedRef.current && generation === generationRef.current;
      setPendingCount(count => count + 1);
      queueRef.current = queueRef.current.then(async () => {
        if (!isCurrent()) return;
        try {
          if (imagesRef.current.length >= MAX_IMAGES) throw new Error('invalid_image');
          const image = await readImage(file);
          if (isCurrent()) commit([...imagesRef.current, image]);
        } catch {
          if (isCurrent()) onInvalidRef.current();
        } finally {
          if (isCurrent()) setPendingCount(count => count - 1);
        }
      });
    }
  }, [commit]);

  const remove = React.useCallback((uid: string) => {
    commit(imagesRef.current.filter(image => image.uid !== uid));
  }, [commit]);

  const clear = React.useCallback(() => {
    generationRef.current += 1;
    setPendingCount(0);
    commit([]);
  }, [commit]);

  const take = React.useCallback(() => {
    const taken = imagesRef.current;
    clear();
    return taken;
  }, [clear]);

  return { images, pendingCount, add, remove, clear, take };
}
