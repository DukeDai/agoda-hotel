import { Star } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface StarRatingProps {
  rating: number | null | undefined;
  className?: string;
  showValue?: boolean;
  size?: 'sm' | 'md';
}

/** Filled / half / empty stars for a hotel's star rating. */
export function StarRating({ rating, className, showValue = false, size = 'sm' }: StarRatingProps) {
  if (rating === null || rating === undefined) return null;
  const starCount = Math.max(0, Math.min(5, Math.round(rating)));
  const iconClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <span className="inline-flex items-center gap-0.5" aria-hidden>
        {Array.from({ length: 5 }, (_, index) => (
          <Star
            key={index}
            className={cn(
              iconClass,
              index < starCount ? 'fill-amber-400 text-amber-400' : 'fill-slate-200 text-slate-200',
            )}
          />
        ))}
      </span>
      <span className="sr-only">{rating} 星</span>
      {showValue ? (
        <span className="text-xs font-semibold text-slate-600">{rating.toFixed(1)}</span>
      ) : null}
    </span>
  );
}
