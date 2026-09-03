import { type ReactNode } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';

export type NoticeKind = 'error' | 'warning';

interface NoticeProps {
  children: ReactNode;
  kind?: NoticeKind;
  icon?: IconName;
}

export function Notice({ children, kind, icon = 'info' }: NoticeProps) {
  return (
    <div className={kind ? `notice ${kind}` : 'notice'}>
      <Icon name={icon} size={18} />
      <span>{children}</span>
    </div>
  );
}
