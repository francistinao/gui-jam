import { events, view } from '@forge/bridge';

const command = document.getElementById('command');
const button = document.getElementById('copy');
if (!command || !button) throw new Error('The copy frame markup is missing.');

let reset: ReturnType<typeof setTimeout> | undefined;

const show = (label: string) => {
  button.textContent = label;
  clearTimeout(reset);
  reset = setTimeout(() => {
    button.textContent = 'Copy';
  }, 2000);
};

button.addEventListener('click', () => {
  navigator.clipboard.writeText(command.textContent ?? '').then(
    () => show('Copied'),
    () => show('Copy failed'),
  );
});

void view.theme.enable();
void events
  .on('guijam:pair-command', (text: unknown) => {
    if (typeof text === 'string') command.textContent = text;
  })
  .then(() => events.emit('guijam:pair-ready'));
