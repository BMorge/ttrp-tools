import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolBridgeError, connectToHost, createAutosave, type HandshakeWindow, type ToolHostClient } from './client';
import { ToolHostSession, type HostedTool, type ToolFrameTarget, type ToolSessionStatus } from './host';
import { TOOLS_PROTOCOL, type ToolManifest } from './protocol';
import { createMemoryStateStore, type ToolStateStore } from './storage';

const HOST_ORIGIN = 'https://timetoroleplay.ru';
const TOOLS_ORIGIN = 'https://tools.timetoroleplay.ru';
const NOW = new Date('2026-10-14T12:00:00.000Z');

const manifest: ToolManifest = {
  manifestVersion: 1,
  id: 'dice',
  version: '0.1.0',
  title: 'Кубики',
  description: 'test',
  bridgeVersion: 1,
  entrypoint: './index.html',
  storageSchemaVersion: 2,
  requestedCapabilities: ['LOCAL_STATE'],
  window: { width: 800, height: 600, minWidth: 400, minHeight: 300, multipleInstances: true },
};

function catalogEntry(overrides: Partial<HostedTool> = {}): HostedTool {
  return {
    manifest,
    allowedCapabilities: ['LOCAL_STATE'],
    limits: { maxStateBytes: 1024 },
    ...overrides,
  };
}

interface Harness {
  session: ToolHostSession;
  storage: ToolStateStore;
  statuses: ToolSessionStatus[];
  dirtyChanges: boolean[];
  toolErrors: Array<{ code: string; fatal: boolean }>;
  toolWindow: HandshakeWindow;
  /** Simulates a message arriving in the shell window. */
  postToHost: (data: unknown, origin?: string, source?: unknown) => void;
}

const disposables: Array<() => void> = [];

afterEach(() => {
  while (disposables.length > 0) {
    disposables.pop()!();
  }
});

/**
 * Two fake windows connected the way browsers connect a page and its iframe: postMessage with a
 * target origin, `event.origin`/`event.source` set by the "browser", ports transferred.
 */
function createHarness(entry: HostedTool = catalogEntry(), toolAppVersion = manifest.version): Harness {
  const storage = createMemoryStateStore();
  const toolListeners = new Set<(event: MessageEvent) => void>();
  const toolWindowProxy = { name: 'tool-window' };
  const statuses: ToolSessionStatus[] = [];
  const dirtyChanges: boolean[] = [];
  const toolErrors: Array<{ code: string; fatal: boolean }> = [];

  let session: ToolHostSession;
  const postToHost = (data: unknown, origin = TOOLS_ORIGIN, source: unknown = toolWindowProxy) => {
    queueMicrotask(() => session.handleWindowMessage({ data: structuredClone(data), origin, source } as MessageEvent));
  };

  const parentProxy = {
    postMessage(message: unknown, targetOrigin: string) {
      if (targetOrigin === HOST_ORIGIN) {
        const patched = toolAppVersion === manifest.version
          ? message
          : { ...(message as object), appVersion: toolAppVersion };
        postToHost(patched);
      }
    },
  };
  const toolWindow: HandshakeWindow = {
    parent: parentProxy,
    addEventListener: (_type, listener) => toolListeners.add(listener),
    removeEventListener: (_type, listener) => toolListeners.delete(listener),
  };
  const frame: ToolFrameTarget = {
    source: toolWindowProxy,
    postMessage(message, targetOrigin, transfer = []) {
      if (targetOrigin !== TOOLS_ORIGIN) {
        return;
      }
      const event = { data: message, origin: HOST_ORIGIN, source: parentProxy, ports: transfer } as unknown as MessageEvent;
      queueMicrotask(() => toolListeners.forEach((listener) => listener(event)));
    },
  };

  session = new ToolHostSession({
    entry,
    binding: { instanceId: 'instance-000001', windowId: 'window-000001', appId: 'dice', appVersion: manifest.version },
    toolsOrigin: TOOLS_ORIGIN,
    userId: 'user-1',
    storage,
    locale: 'ru-RU',
    visible: true,
    frame,
    timing: { helloIntervalMs: 5, handshakeTimeoutMs: 300 },
    now: () => NOW,
    onStatusChange: (status) => statuses.push(status),
    onDirtyChange: (dirty) => dirtyChanges.push(dirty),
    onToolError: (error) => toolErrors.push({ code: error.code, fatal: error.fatal }),
  });
  disposables.push(() => session.dispose());
  return { session, storage, statuses, dirtyChanges, toolErrors, toolWindow, postToHost };
}

async function connect(harness: Harness, timeoutMs = 1000): Promise<ToolHostClient> {
  const client = await connectToHost({
    appId: 'dice',
    appVersion: manifest.version,
    allowedHostOrigins: [HOST_ORIGIN],
    targetWindow: harness.toolWindow,
    timeoutMs,
  });
  disposables.push(() => client.dispose());
  return client;
}

describe('tools bridge', () => {
  it('connects even when the tool starts listening after the first HELLO', async () => {
    const harness = createHarness();
    harness.session.handleFrameLoad();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const client = await connect(harness);

    expect(harness.session.currentStatus).toEqual({ kind: 'ready' });
    expect(client.binding).toEqual({
      instanceId: 'instance-000001',
      windowId: 'window-000001',
      appId: 'dice',
      appVersion: '0.1.0',
    });
    expect(client.grantedCapabilities).toEqual(['LOCAL_STATE']);
    expect(client.locale).toBe('ru-RU');
  });

  it('saves and loads state under the bound user, app and window', async () => {
    const harness = createHarness();
    harness.session.handleFrameLoad();
    const client = await connect(harness);

    await expect(client.request('state.load', {})).resolves.toBeNull();
    await expect(client.request('state.save', { state: { rolls: [1, 2] }, schemaVersion: 2 }))
      .resolves.toEqual({ updatedAt: NOW.toISOString() });
    await expect(client.request('state.load', {})).resolves.toEqual({
      state: { rolls: [1, 2] },
      schemaVersion: 2,
      updatedAt: NOW.toISOString(),
    });
    await expect(harness.storage.loadWindowState({ userId: 'user-1', appId: 'dice', windowId: 'window-000001' }))
      .resolves.toMatchObject({ current: { state: { rolls: [1, 2] } } });
  });

  it('rejects requests outside the granted capabilities, limits and schema', async () => {
    const denied = createHarness(catalogEntry({ allowedCapabilities: [] }));
    denied.session.handleFrameLoad();
    const deniedClient = await connect(denied);
    expect(deniedClient.grantedCapabilities).toEqual([]);
    await expect(deniedClient.request('state.load', {})).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const harness = createHarness();
    harness.session.handleFrameLoad();
    const client = await connect(harness);
    await expect(client.request('state.save', { state: 'x'.repeat(2000), schemaVersion: 1 }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(client.request('state.save', { state: {}, schemaVersion: 3 }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.request('state.delete' as never, {} as never))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
  });

  it('ignores TOOL_READY from a wrong origin or window and times out', async () => {
    const harness = createHarness();
    harness.session.handleFrameLoad();
    const ready = {
      protocol: TOOLS_PROTOCOL,
      bridgeVersion: 1,
      type: 'TOOL_READY',
      instanceId: 'instance-000001',
      appId: 'dice',
      appVersion: '0.1.0',
      challenge: 'not-the-challenge',
    };
    harness.postToHost(ready, 'https://evil.example');
    harness.postToHost(ready, TOOLS_ORIGIN, { name: 'other-window' });
    harness.postToHost(ready);

    await vi.waitFor(() => expect(harness.session.currentStatus).toEqual({ kind: 'failed', reason: 'HANDSHAKE_TIMEOUT', detail: undefined }));
  });

  it('fails when the deployed tool version differs from the catalog', async () => {
    const harness = createHarness(catalogEntry(), '0.2.0');
    harness.session.handleFrameLoad();

    await expect(connect(harness, 100)).rejects.toBeInstanceOf(ToolBridgeError);
    expect(harness.session.currentStatus).toEqual({ kind: 'failed', reason: 'VERSION_MISMATCH', detail: 'dice@0.2.0' });
  });

  it('treats a second frame load as a new, untrusted document', async () => {
    const harness = createHarness();
    harness.session.handleFrameLoad();
    const client = await connect(harness);
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    harness.session.handleFrameLoad();

    await vi.waitFor(() => expect(client.closed).toBe(true));
    expect(events).toEqual(['SESSION_REVOKED']);
    expect(harness.session.currentStatus).toMatchObject({ kind: 'failed', reason: 'RELOADED' });
  });

  it('waits for closeReady or the deadline when closing', async () => {
    const harness = createHarness();
    harness.session.handleFrameLoad();
    const client = await connect(harness);
    let closeReadyAnswer: Promise<null> | null = null;
    client.subscribe((event) => {
      if (event.type === 'CLOSE_REQUESTED') {
        expect(event.reason).toBe('USER_CLOSE');
        closeReadyAnswer = client.request('lifecycle.closeReady', { closeRequestId: event.closeRequestId });
      }
    });

    const started = Date.now();
    await harness.session.requestClose('USER_CLOSE', 5000);
    // The shell disposes the session right after the close resolves; the tool still gets its answer.
    harness.session.dispose();
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(closeReadyAnswer).resolves.toBeNull();

    const silent = createHarness();
    silent.session.handleFrameLoad();
    await connect(silent);
    await silent.session.requestClose('NAVIGATION', 20);
  });

  it('tells the tool to stop on revoke and rejects its pending requests', async () => {
    const harness = createHarness();
    harness.session.handleFrameLoad();
    const client = await connect(harness);
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    harness.session.revoke();

    await vi.waitFor(() => expect(events).toEqual(['SESSION_REVOKED']));
    expect(client.closed).toBe(true);
    await expect(client.request('state.load', {})).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  });

  it('reports unsaved changes through autosave', async () => {
    const harness = createHarness();
    harness.session.handleFrameLoad();
    const client = await connect(harness);
    let state = { count: 0 };
    const autosave = createAutosave(client, { schemaVersion: 2, getState: () => state, debounceMs: 5 });

    state = { count: 1 };
    autosave.schedule();
    state = { count: 2 };
    autosave.schedule();
    await autosave.flush();

    await vi.waitFor(() => expect(harness.dirtyChanges).toEqual([true, false]));
    await expect(client.request('state.load', {})).resolves.toMatchObject({ state: { count: 2 } });
  });

  it('stops the instance after a fatal tool error, answering the report first', async () => {
    const harness = createHarness();
    harness.session.handleFrameLoad();
    const client = await connect(harness);

    await expect(client.request('lifecycle.reportError', { code: 'WEBGL_CONTEXT_LOST', message: 'lost', fatal: true }))
      .resolves.toBeNull();

    await vi.waitFor(() => expect(harness.session.currentStatus).toMatchObject({ kind: 'failed', reason: 'TOOL_FATAL' }));
    expect(harness.toolErrors).toEqual([{ code: 'WEBGL_CONTEXT_LOST', fatal: true }]);
  });
});
