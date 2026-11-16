import { Input as BaseInput } from '@base-ui/react';
import { cn } from './cn';

const INPUT_BASE_CLASS =
  'placeholder:text-grey-400 text-black-800 bg-grey-100 typography-body-medium hover:ring-grey-200 flex h-6 w-full min-w-0 items-center rounded-md px-2 ring ring-transparent outline-none selection:bg-blue-500 focus:ring-blue-500 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-red-500';

function TextInput({ className, ...props }: BaseInput.Props) {
  return <BaseInput {...props} data-slot="input" className={cn(INPUT_BASE_CLASS, className)} />;
}

export { INPUT_BASE_CLASS, TextInput };
