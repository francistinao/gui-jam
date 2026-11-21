import { view } from '@forge/bridge';
import ForgeReconciler, { Box, Button, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { useEffect, useState } from 'react';
import { call } from './call';

type State = 'sending' | 'queued' | 'in_progress' | 'applied' | 'failed';

const MESSAGES: Record<Exclude<State, 'sending' | 'failed'>, string> = {
  queued:
    'Sent to GUIJam. Developers see it under "Sent to GUIJam" when they link a ticket in their app.',
  in_progress: 'A developer is already working on this in GUIJam.',
  applied: 'GUIJam already applied a change for this ticket. See the GUIJam panel.',
};

function App() {
  const [state, setState] = useState<State>('sending');

  useEffect(() => {
    call<{ status: State }>('queue').then(
      (answer) => setState(answer.status),
      () => setState('failed'),
    );
  }, []);

  return (
    <Stack space="space.200">
      {state === 'sending' ? <Spinner label="Sending to GUIJam" /> : null}
      {state === 'failed' ? (
        <SectionMessage appearance="error">
          <Text>GUIJam could not update this ticket. You may not be allowed to edit it.</Text>
        </SectionMessage>
      ) : null}
      {state !== 'sending' && state !== 'failed' ? <Text>{MESSAGES[state]}</Text> : null}
      <Box>
        <Button onClick={() => void view.close()}>Close</Button>
      </Box>
    </Stack>
  );
}

ForgeReconciler.render(<App />);
