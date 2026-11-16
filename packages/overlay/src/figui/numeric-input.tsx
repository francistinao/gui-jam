import { NumberField } from '@base-ui/react/number-field';
import type * as React from 'react';
import { cn } from './cn';
import { INPUT_BASE_CLASS } from './text-input';

interface NumericInputRootProps
  extends Omit<NumberField.Root.Props, 'value' | 'onValueChange' | 'step'> {
  value: number | null;
  onValueChange(next: number | null): void;
  /** Arrow keys and scrubbing change the value by this much. */
  nudgeAmount?: number;
}

function NumericInputRoot({
  value,
  onValueChange,
  nudgeAmount = 1,
  className,
  children,
  ...props
}: NumericInputRootProps) {
  return (
    <NumberField.Root
      {...props}
      value={value}
      onValueChange={onValueChange}
      step={nudgeAmount}
      data-slot="section"
      className={cn(
        'inline-flex h-6 items-center rounded-md',
        'has-data-scrubbing:cursor-ew-resize has-data-scrubbing:ring-blue-600!',
        className,
      )}
    >
      {children}
    </NumberField.Root>
  );
}

function NumericInput({ className, ...props }: NumberField.Input.Props) {
  return (
    <NumberField.Input
      {...props}
      data-slot="input"
      className={cn(INPUT_BASE_CLASS, 'flex-1', className)}
    />
  );
}

function NumericScrubArea({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <NumberField.ScrubArea
      direction="horizontal"
      pixelSensitivity={8}
      className={cn('cursor-ew-resize select-none', className)}
    >
      {children}
    </NumberField.ScrubArea>
  );
}

export { NumericInput, NumericInputRoot, NumericScrubArea };
