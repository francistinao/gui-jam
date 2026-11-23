import { ErrorMessage } from '../../components/ErrorMessage';

export function RewardsSignup() {
  return (
    <section id="rewards" className="px-12 pt-12 pb-96">
      <h3 className="text-xl font-semibold">Join Brew Rewards</h3>
      <form className="mt-4 flex max-w-md flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input name="name" className="rounded-lg border border-espresso px-3 py-2" />
          <ErrorMessage message="Enter your name." />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" className="rounded-lg border border-espresso px-3 py-2" />
          <p className="mt-2 text-xs text-red-500">Enter a valid email address.</p>
        </label>
        <p className="mt-1 text-xs text-espresso/70">Points arrive within a day.</p>
      </form>
    </section>
  );
}
