import { type ReactNode } from 'react';

export type IconName =
  | 'upload'
  | 'download'
  | 'trash'
  | 'close'
  | 'plus'
  | 'settings'
  | 'lock'
  | 'info'
  | 'retry'
  | 'chevron';

export const iconPaths: Record<IconName, ReactNode> = {
  upload: (
    <>
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
      <path d="M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9 11v5m6-5v5M7 7l.7 12h8.6L17 7M9 7l.8-3h4.4l.8 3" />
    </>
  ),
  close: <path d="m7 7 10 10M17 7 7 17" />,
  plus: <path d="M12 5v14M5 12h14" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.57 15 1.7 1.7 0 0 0 3 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.57 1.7 1.7 0 0 0 10 3V3h4v.08A1.7 1.7 0 0 0 15.06 4.6a1.7 1.7 0 0 0 1.88-.34L17 4.2 19.83 7l-.06.06A1.7 1.7 0 0 0 19.43 9 1.7 1.7 0 0 0 21 10h.08v4H21A1.7 1.7 0 0 0 19.4 15Z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5m0-8h.01" />
    </>
  ),
  retry: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M18.5 16A7.5 7.5 0 1 1 20 12" />
    </>
  ),
  chevron: <path d="m8 10 4 4 4-4" />,
};
