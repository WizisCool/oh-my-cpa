import React from 'react';
import { Button } from 'antd';
import { PlusOutlined, UploadOutlined } from '../icons';
import styles from './FileDropzone.module.css';

interface FileDropzoneProps {
  title: React.ReactNode;
  hint: React.ReactNode;
  chooseLabel: React.ReactNode;
  /** Names the hidden file input for assistive technology. */
  inputLabel: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  /** Shown under the button, such as the chosen file's name. */
  children?: React.ReactNode;
}

/** FileDropzone takes files either dropped onto it or chosen through its button. */
export const FileDropzone: React.FC<FileDropzoneProps> = ({
  title, hint, chooseLabel, inputLabel, accept, multiple, disabled, onFiles, children,
}) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [isDragActive, setIsDragActive] = React.useState(false);

  const take = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
  };

  return (
    <div
      className={[styles['dropzone'], isDragActive ? styles['dropzone-active'] : ''].join(' ')}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setIsDragActive(true);
      }}
      onDragLeave={() => setIsDragActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragActive(false);
        if (!disabled) take(event.dataTransfer.files);
      }}
    >
      <UploadOutlined className={styles['upload-mark']} />
      <strong>{title}</strong>
      <span>{hint}</span>
      <Button icon={<PlusOutlined />} disabled={disabled} onClick={() => inputRef.current?.click()}>
        {chooseLabel}
      </Button>
      <input
        ref={inputRef}
        className={styles['file-input']}
        type="file"
        accept={accept}
        multiple={multiple}
        tabIndex={-1}
        aria-label={inputLabel}
        disabled={disabled}
        onChange={(event) => {
          take(event.target.files);
          event.target.value = '';
        }}
      />
      {children}
    </div>
  );
};
