import type { TrackerProject } from '@guijam/contracts-ts';
import { LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import type { Controller } from './controller';
import { Button } from './figui/button';
import { cn } from './figui/cn';
import { INPUT_BASE_CLASS, TextInput } from './figui/text-input';

export function ReportForm({
  projects,
  busy,
  controller,
  onClose,
}: {
  projects: readonly TrackerProject[];
  busy: boolean;
  controller: Controller;
  onClose: () => void;
}) {
  const [project, setProject] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const chosen = project || projects[0]?.key || '';

  const submit = async () => {
    setSending(true);
    const created = await controller.reportToJira({ project: chosen, summary, description });
    setSending(false);
    if (created) onClose();
  };

  return (
    <form
      aria-label="Report to Jira"
      aria-busy={sending}
      className="flex flex-col gap-1.5 rounded-md p-2 ring-1 ring-grey-200"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="typography-body-small flex items-center gap-1">
        Project
        <select
          aria-label="Project"
          value={chosen}
          disabled={sending}
          className="typography-body-small h-6 cursor-pointer rounded-md border-0 bg-white-1000 px-1"
          onChange={(event) => setProject(event.target.value)}
        >
          {projects.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {`${entry.key} · ${entry.name}`}
            </option>
          ))}
        </select>
      </label>
      <TextInput
        aria-label="Ticket summary"
        placeholder="What's wrong with this element?"
        value={summary}
        maxLength={255}
        disabled={sending}
        onChange={(event) => setSummary(event.target.value)}
      />
      <textarea
        aria-label="Ticket description"
        placeholder="Details (optional)"
        rows={3}
        maxLength={4000}
        value={description}
        disabled={sending}
        className={cn(INPUT_BASE_CLASS, 'h-auto resize-none py-1')}
        onChange={(event) => setDescription(event.target.value)}
      />
      <p className="typography-body-small m-0 text-grey-500">
        A screenshot of the element, its file and line, and this page's address are added for you.
      </p>
      <div className="flex items-center justify-end gap-2">
        {sending ? (
          <span role="status" className="typography-body-small mr-auto flex items-center gap-1.5">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-blue-500" />
            Creating the ticket…
          </span>
        ) : null}
        <Button type="button" variant="secondary" disabled={sending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || sending || !summary.trim()}>
          Create ticket
        </Button>
      </div>
    </form>
  );
}
