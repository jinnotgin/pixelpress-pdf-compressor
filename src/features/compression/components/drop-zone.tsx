import { type DragEvent, useRef } from 'react';

import { Icon } from '@/components/ui/icon';

interface DropZoneProps {
  compact?: boolean;
  dragging: boolean;
  onDrag: (dragging: boolean) => void;
  onFiles: (files: FileList | null) => void;
}

export function DropZone({ compact = false, dragging, onDrag, onFiles }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const openPicker = () => inputRef.current?.click();

  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onDrag(false);
    onFiles(event.dataTransfer.files);
  };

  const dragOver = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onDrag(true);
  };

  return (
    <>
      <button
        type="button"
        className={`${compact ? 'compact-drop' : 'drop-zone'} ${dragging ? 'dragging' : ''}`}
        onClick={openPicker}
        onDragEnter={dragOver}
        onDragOver={dragOver}
        onDragLeave={() => onDrag(false)}
        onDrop={drop}
      >
        {compact ? (
          <>
            <Icon name="plus" size={17} />
            <span>Drop more PDFs here or choose files</span>
          </>
        ) : (
          <span className="drop-content">
            <span className="drop-icon">
              <Icon name="upload" size={28} />
            </span>
            <h2>Drop PDFs here to compress</h2>
            <span className="drop-cta">
              <Icon name="plus" size={16} /> Choose PDF files
            </span>
            <span className="drop-meta">Up to 250 MB per file</span>
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        onChange={(event) => {
          onFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </>
  );
}
