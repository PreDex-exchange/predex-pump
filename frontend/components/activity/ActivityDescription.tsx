import Link from 'next/link';
import { Fragment } from 'react';

import type { ActivityDescription as Description } from '@/lib/activity';

interface ActivityDescriptionProps {
  description: Description;
  marketClassName?: string;
  valueClassName?: string;
}

export function ActivityDescription({
  description,
  marketClassName,
  valueClassName,
}: ActivityDescriptionProps) {
  return description.segments.map((segment, index) => {
    const key = `${segment.kind}:${index}`;
    if (segment.kind === 'value') {
      return (
        <span className={valueClassName} key={key}>
          {segment.text}
        </span>
      );
    }
    if (segment.kind === 'market') {
      return segment.href ? (
        <Link className={marketClassName} href={segment.href} key={key}>
          {segment.text}
        </Link>
      ) : (
        <strong key={key}>{segment.text}</strong>
      );
    }
    return <Fragment key={key}>{segment.text}</Fragment>;
  });
}
