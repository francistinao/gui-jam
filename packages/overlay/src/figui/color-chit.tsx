import { cn } from './cn';

interface ColorChitProps {
  color: string;
  opacity?: number;
  className?: string;
}

function ColorChit({ color, opacity, className }: ColorChitProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 justify-start overflow-hidden rounded-sm inset-ring inset-ring-black-200',
        className,
      )}
      style={{
        backgroundImage: 'conic-gradient(#eee 25%, #ccc 0 50%, #eee 0 75%, #ccc 0)',
        backgroundSize: '8px 8px',
      }}
    >
      <div className="h-full w-1/2" style={{ backgroundColor: color }} />
      <div
        className="h-full w-1/2"
        style={{
          backgroundColor: color,
          opacity: opacity === undefined ? undefined : opacity / 100,
        }}
      />
    </div>
  );
}

export { ColorChit };
