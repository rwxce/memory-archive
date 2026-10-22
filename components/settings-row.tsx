import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/components/ui/utils';

export const settingsRowClass =
  'border-line focus-visible:ring-ring/50 flex min-h-16 w-full items-center gap-3 border-b px-5 py-2 text-start outline-none last:border-b-0 focus-visible:ring-[3px] focus-visible:ring-inset aria-disabled:opacity-50';

/** The inside of a settings row (title, hint, optional current value, chevron); wrap it in a link or a button with `settingsRowClass`. */
export function SettingsRowContent({ title, hint, value }: { title: ReactNode; hint?: ReactNode; value?: ReactNode }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium">{title}</span>
        {hint && <span className="text-mu block text-xs leading-snug">{hint}</span>}
      </span>
      {value && <span className="text-t2 text-sm">{value}</span>}
      <ChevronRight className="text-mu size-[18px] shrink-0 rtl:rotate-180" aria-hidden />
    </>
  );
}

/** A flat card holding a list of rows. */
export function SettingsRows({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('bg-sf flex flex-col overflow-hidden rounded-3xl lg:in-data-panel:bg-bg', className)}>{children}</section>;
}
