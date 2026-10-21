'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SmartImageProps {
  src?: string | null;
  alt: string;
  className?: string;
  /** Rendered when there is no image, or when the image fails to load. */
  fallback?: ReactNode;
  fallbackClassName?: string;
  loading?: 'lazy' | 'eager';
}

/**
 * An `<img>` that degrades to a placeholder instead of showing a broken-image
 * glyph. Supplier CDN images can 404 or be blocked, and an empty grey block
 * looks worse than a clean placeholder.
 */
export function SmartImage({
  src,
  alt,
  className,
  fallback,
  fallbackClassName = 'bg-slate-100',
  loading = 'lazy',
}: SmartImageProps) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className={cn(fallbackClassName, className)} aria-hidden={!fallback}>
        {fallback}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading={loading}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
