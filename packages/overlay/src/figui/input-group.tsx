import type * as React from 'react';
import { cn } from './cn';

const INPUT_GROUP_CLASS = [
  'bg-grey-100 inline-flex h-6 items-center rounded-md',
  'ring ring-transparent hover:ring-grey-200',
  'focus-within:ring-blue-500!',
  'has-data-scrubbing:ring-blue-600!',
  '[&_[data-slot=input]]:h-full',
  '[&_[data-slot=input]]:rounded-none!',
  '[&_[data-slot=input]]:bg-transparent!',
  '[&_[data-slot=input]]:px-0!',
  '[&_[data-slot=input]]:ring-0!',
  '[&_[data-slot=input]]:ring-transparent!',
  '[&>[data-slot=section]]:h-full',
  '[&>[data-slot=section]]:rounded-none!',
  '[&>[data-slot=section]]:ring-transparent!',
  '[&>[data-slot=input]:first-child]:pl-1.5!',
  '[&>[data-slot=input]:last-child]:pr-1.5!',
  '[&>[data-slot=section]>[data-slot=input]:last-child]:pr-1.5!',
].join(' ');

function InputGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(INPUT_GROUP_CLASS, className)} {...props} />;
}

function InputGroupAddon({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="addon"
      className={cn(
        'flex size-6 shrink-0 items-center justify-center text-xs text-grey-500',
        className,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon };
