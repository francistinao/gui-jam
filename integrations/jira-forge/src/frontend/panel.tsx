import ForgeReconciler, {
  Box,
  Button,
  Code,
  CodeBlock,
  Heading,
  Image,
  Inline,
  Link,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  User,
  useProductContext,
} from '@forge/react';
import { useCallback, useEffect, useState } from 'react';
import type { Device } from '../pairing';
import type { PanelData } from '../resolvers';
import { call } from './call';

const STATUS = {
  none: { label: 'Not linked', appearance: 'default' },
  queued: { label: 'Sent to GUIJam', appearance: 'new' },
  in_progress: { label: 'In progress', appearance: 'inprogress' },
  applied: { label: 'Applied', appearance: 'success' },
  reverted: { label: 'Reverted', appearance: 'removed' },
} as const;

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function Shots({ ids, site, label }: { ids: string[]; site: string; label: string }) {
  if (ids.length === 0) return null;
  return (
    <Stack space="space.050">
      <Text weight="medium">{label}</Text>
      {ids.map((id) => (
        <Image
          key={id}
          src={`${site}/rest/api/3/attachment/content/${id}`}
          alt={`${label} screenshot`}
          width={220}
        />
      ))}
    </Stack>
  );
}

function Pairing({ devices, onChange }: { devices: Device[]; onChange: () => Promise<void> }) {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pair = async () => {
    setBusy(true);
    try {
      const paired = await call<{ code: string }>('pair', { label: 'GUIJam' });
      setCode(paired.code);
      await onChange();
    } finally {
      setBusy(false);
    }
  };
  const revokeDevice = async (deviceId: string) => {
    setBusy(true);
    try {
      await call('revoke', { deviceId });
      await onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack space="space.100">
      <Heading size="xsmall">Pair GUIJam</Heading>
      <Text>
        Pairing lets GUIJam on your machine read your UI tickets and post the changes you apply. It
        acts only where your own Jira permissions allow.
      </Text>
      {code ? (
        <SectionMessage appearance="success" title="Run this in your project">
          <CodeBlock text={`npx guijam jira pair ${code}`} />
          <Text>This code is shown once. Anyone with it can act as you through GUIJam.</Text>
        </SectionMessage>
      ) : null}
      {devices.map((device) => (
        <Inline key={device.id} space="space.100" alignBlock="center" spread="space-between">
          <Text>{`${device.label} · paired ${when(new Date(device.createdAt).toISOString())}`}</Text>
          <Button
            appearance="subtle"
            isDisabled={busy}
            onClick={() => void revokeDevice(device.id)}
          >
            Revoke
          </Button>
        </Inline>
      ))}
      <Box>
        <Button appearance="primary" isDisabled={busy} onClick={() => void pair()}>
          {devices.length > 0 ? 'Pair another device' : 'Pair GUIJam'}
        </Button>
      </Box>
    </Stack>
  );
}

function App() {
  const context = useProductContext();
  const site = (context?.siteUrl ?? '').replace(/\/$/, '');
  const issueKey = (context?.extension as { issue?: { key?: string } } | undefined)?.issue?.key;
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await call<PanelData>('panelData'));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'GUIJam could not load.');
    }
  }, []);

  useEffect(() => {
    if (issueKey) void load();
  }, [issueKey, load]);

  if (error) return <SectionMessage appearance="error">{error}</SectionMessage>;
  if (!data) return <Spinner label="Loading GUIJam" />;
  const status = STATUS[data.status];
  const { result, property } = data;
  const open =
    property?.pageUrl && issueKey
      ? `${property.pageUrl}${property.pageUrl.includes('?') ? '&' : '?'}guijam-ticket=${issueKey}`
      : null;

  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center">
        <Lozenge appearance={status.appearance}>{status.label}</Lozenge>
        {property?.file ? <Code>{property.file}</Code> : null}
      </Inline>
      {result ? (
        <Stack space="space.100">
          <Inline space="space.050" alignBlock="center">
            <Text>{result.status === 'reverted' ? 'Applied, then undone, by' : 'Applied by'}</Text>
            <User accountId={result.accountId} />
            <Text>{`on ${when(result.appliedAt)}`}</Text>
          </Inline>
          <Text>{result.agent}</Text>
          <Inline space="space.200">
            <Shots ids={result.before} site={site} label="Before" />
            <Shots ids={result.after} site={site} label="After" />
          </Inline>
          {result.files.map((file) => (
            <Code key={file}>{file}</Code>
          ))}
          {result.diff ? <CodeBlock text={result.diff} language="diff" /> : null}
          {result.patch ? (
            <Link href={`${site}/rest/api/3/attachment/content/${result.patch}`} openNewTab>
              Full diff
            </Link>
          ) : null}
        </Stack>
      ) : (
        <Text>
          {data.status === 'none'
            ? 'No GUIJam change is linked yet. Use "Send to GUIJam" in the ••• menu to queue this ticket for a developer.'
            : 'A developer is working on this in GUIJam.'}
        </Text>
      )}
      {open ? (
        <Stack space="space.050">
          <Link href={open} openNewTab>
            Open in GUIJam
          </Link>
          <Text size="small">Opens the page on the machine of the developer who linked it.</Text>
        </Stack>
      ) : null}
      <Pairing devices={data.devices} onChange={load} />
    </Stack>
  );
}

ForgeReconciler.render(<App />);
