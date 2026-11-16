import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { cn } from './cn';

function Tabs({ className, ...props }: BaseTabs.Root.Props) {
  return <BaseTabs.Root {...props} className={cn('overflow-hidden outline-none', className)} />;
}

function TabsList({ className, ...props }: BaseTabs.List.Props) {
  return (
    <BaseTabs.List
      {...props}
      className={cn('no-scrollbar flex gap-1 overflow-x-auto outline-none', className)}
    />
  );
}

function Tab({ className, ...props }: BaseTabs.Tab.Props) {
  return (
    <BaseTabs.Tab
      {...props}
      className={cn(
        'typography-body-medium h-6 shrink-0 rounded-md px-2 text-black-500 outline-none hover:bg-grey-100 focus-visible:inset-ring focus-visible:inset-ring-blue-500 data-active:bg-grey-100 data-active:font-[500] data-active:text-black-1000',
        className,
      )}
    />
  );
}

function TabsPanel({ className, ...props }: BaseTabs.Panel.Props) {
  return <BaseTabs.Panel {...props} className={cn('outline-none', className)} />;
}

export { Tab, Tabs, TabsList, TabsPanel };
