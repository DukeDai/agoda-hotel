'use client';

import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { HotelImage } from '@/lib/api';
import { SmartImage } from '@/components/SmartImage';
import { cn } from '@/lib/cn';

export interface HotelGalleryProps {
  images: HotelImage[] | null | undefined;
  fallbackThumbnail?: string | null;
  alt: string;
  className?: string;
}

/** Main image + thumbnail strip. Falls back to the hotel thumbnail. */
export function HotelGallery({ images, fallbackThumbnail, alt, className }: HotelGalleryProps) {
  const gallery = (images ?? []).filter((image) => Boolean(image?.url));
  const source = gallery.length > 0 ? gallery : fallbackThumbnail ? [{ url: fallbackThumbnail }] : [];
  const [active, setActive] = useState(0);

  const current = source[Math.min(active, Math.max(0, source.length - 1))];

  return (
    <div className={cn('space-y-3', className)}>
      <div className="relative overflow-hidden rounded-xl bg-slate-100">
        {current ? (
          <SmartImage
            src={current.url}
            alt={current.caption ?? alt}
            className="aspect-[16/10] w-full object-cover sm:aspect-[16/8]"
            fallbackClassName="flex aspect-[16/10] w-full items-center justify-center bg-slate-100 text-slate-300 sm:aspect-[16/8]"
            fallback={<ImageOff className="h-8 w-8" aria-hidden />}
          />
        ) : (
          <div className="flex aspect-[16/10] w-full items-center justify-center text-slate-300 sm:aspect-[16/8]">
            <ImageOff className="h-8 w-8" aria-hidden />
          </div>
        )}
        {current?.caption ? (
          <span className="absolute bottom-3 left-3 rounded-md bg-black/55 px-2.5 py-1 text-xs text-white">
            {current.caption}
          </span>
        ) : null}
      </div>

      {source.length > 1 ? (
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-6">
          {source.slice(0, 6).map((image, index) => (
            <button
              key={`${image.url}-${index}`}
              type="button"
              onClick={() => setActive(index)}
              aria-label={`查看第 ${index + 1} 张图片`}
              aria-current={index === active}
              className={cn(
                'overflow-hidden rounded-lg border-2 bg-slate-100 transition',
                index === active
                  ? 'border-brand-600'
                  : 'border-transparent hover:border-slate-300',
              )}
            >
              <img src={image.url} alt="" className="h-16 w-full object-cover" onError={(event) => {
                const el = event.currentTarget;
                el.style.visibility = 'hidden';
              }} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
