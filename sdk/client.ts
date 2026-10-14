import {
  BRIDGE_VERSION,
  TOOLS_PROTOCOL,
  createProtocolToken,
  hostConnectSchema,
  hostEventSchema,
  hostHelloSchema,
  hostMethodResultSchemas,
  toolResponseSchema,
  type HostConnectMessage,
  type HostErrorCode,
  type HostEvent,
  type HostHelloMessage,
  type HostMethod,
  type HostMethodParams,
  type HostMethodResult,
  type JsonValue,
  type ToolBinding,
  type ToolCapability,
  type ToolReadyMessage,
  type ToolResponse,
} from './protocol';

/** Tool side of the bridge: what an embedded application uses to talk to the TtRP shell. */

export type ToolBridgeErrorCode =
  | HostErrorCode
  | 'ABORTED'
  | 'NOT_EMBEDDED'
  | 'HANDSHAKE_TIMEOUT'
  | 'INVALID_RESPONSE';

export class ToolBridgeError extends Error {
  readonly code: ToolBridgeErrorCode;

  constructor(code: ToolBridgeErrorCode, message: string) {
    super(message);
    this.name = 'ToolBridgeError';
    this.code = code;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ToolHostClient {
  readonly binding: Readonly<ToolBinding>;
  readonly grantedCapabilities: readonly ToolCapability[];
  readonly locale: string;
  readonly initiallyVisible: boolean;
  readonly closed: boolean;
  /**
   * Abort and timeout are client-side only in bridge v1: the host may still apply the request,
   * so a timed out save does not mean "not saved".
   */
  request<M extends HostMethod>(
    method: M,
    params: HostMethodParams<M>,
    options?: RequestOptions,
  ): Promise<HostMethodResult<M>>;
  subscribe(listener: (event: HostEvent) => void): () => void;
  dispose(): void;
}

/** The subset of `window` the handshake needs; tests pass a fake. */
export interface HandshakeWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface ConnectOptions {
  appId: string;
  appVersion: string;
  /** Shell origins this build trusts; fixed at build time from the environment. */
  allowedHostOrigins: readonly string[];
  timeoutMs?: number;
  targetWindow?: HandshakeWindow;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Waits for the shell's HOST_HELLO, answers TOOL_READY and resolves on HOST_CONNECT.
 * Call it as early as possible: the shell repeats HELLO, but the listener should not wait for heavy init.
 */
export function connectToHost(options: ConnectOptions): Promise<ToolHostClient> {
  const target = options.targetWindow ?? (window as unknown as HandshakeWindow);
  const parent = target.parent;
  if (!parent || (parent as unknown) === target) {
    return Promise.reject(new ToolBridgeError('NOT_EMBEDDED', 'Инструмент открыт вне оболочки TtRP'));
  }

  return new Promise((resolve, reject) => {
    let hello: HostHelloMessage | null = null;
    let helloOrigin = '';

    const finish = () => {
      clearTimeout(timer);
      target.removeEventListener('message', onMessage);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== (parent as unknown) || !options.allowedHostOrigins.includes(event.origin)) {
        return;
      }

      const helloResult = hostHelloSchema.safeParse(event.data);
      if (helloResult.success) {
        const message = helloResult.data;
        if (message.appId !== options.appId) {
          return;
        }
        // The shell repeats the same HELLO until it sees TOOL_READY; another instance is ignored.
        if (hello && (message.instanceId !== hello.instanceId || message.challenge !== hello.challenge)) {
          return;
        }
        hello = message;
        helloOrigin = event.origin;
        const ready: ToolReadyMessage = {
          protocol: TOOLS_PROTOCOL,
          bridgeVersion: BRIDGE_VERSION,
          type: 'TOOL_READY',
          challenge: message.challenge,
          instanceId: message.instanceId,
          appId: options.appId,
          appVersion: options.appVersion,
        };
        parent.postMessage(ready, event.origin);
        return;
      }

      if (!hello) {
        return;
      }
      const connectResult = hostConnectSchema.safeParse(event.data);
      if (!connectResult.success) {
        return;
      }
      const connect = connectResult.data;
      if (
        event.origin !== helloOrigin
        || connect.instanceId !== hello.instanceId
        || connect.challenge !== hello.challenge
        || event.ports.length !== 1
      ) {
        return;
      }
      finish();
      resolve(new PortToolHostClient(event.ports[0], connect));
    };

    const timer = setTimeout(() => {
      finish();
      reject(new ToolBridgeError('HANDSHAKE_TIMEOUT', 'Оболочка TtRP не ответила'));
    }, options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    target.addEventListener('message', onMessage);
  });
}

interface PendingRequest {
  method: HostMethod;
  resolve: (value: unknown) => void;
  reject: (error: ToolBridgeError) => void;
}

class PortToolHostClient implements ToolHostClient {
  readonly binding: Readonly<ToolBinding>;
  readonly grantedCapabilities: readonly ToolCapability[];
  readonly locale: string;
  readonly initiallyVisible: boolean;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private isClosed = false;

  constructor(private readonly port: MessagePort, connect: HostConnectMessage) {
    this.binding = Object.freeze({
      instanceId: connect.instanceId,
      windowId: connect.windowId,
      appId: connect.appId,
      appVersion: connect.appVersion,
    });
    this.grantedCapabilities = Object.freeze([...connect.grantedCapabilities]);
    this.locale = connect.locale;
    this.initiallyVisible = connect.visible;
    this.port.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  request<M extends HostMethod>(
    method: M,
    params: HostMethodParams<M>,
    options: RequestOptions = {},
  ): Promise<HostMethodResult<M>> {
    if (this.isClosed) {
      return Promise.reject(new ToolBridgeError('SESSION_CLOSED', 'Связь с оболочкой закрыта'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ToolBridgeError('ABORTED', 'Запрос отменён'));
    }

    const requestId = createProtocolToken();
    return new Promise<HostMethodResult<M>>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(requestId);
      };
      const fail = (error: ToolBridgeError) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(new ToolBridgeError('ABORTED', 'Запрос отменён'));
      const timeout = setTimeout(
        () => fail(new ToolBridgeError('TIMEOUT', 'Оболочка не ответила вовремя')),
        options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(requestId, {
        method,
        resolve: (value) => {
          cleanup();
          resolve(value as HostMethodResult<M>);
        },
        reject: fail,
      });
      this.port.postMessage({
        type: 'REQUEST',
        instanceId: this.binding.instanceId,
        requestId,
        method,
        params,
      });
    });
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    if (this.isClosed) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.close();
  }

  private handleMessage(data: unknown): void {
    const response = toolResponseSchema.safeParse(data);
    if (response.success) {
      this.handleResponse(response.data);
      return;
    }

    const event = hostEventSchema.safeParse(data);
    if (!event.success || event.data.instanceId !== this.binding.instanceId) {
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event.data);
      } catch (error) {
        console.error('[tools-sdk] host event listener failed', error);
      }
    }
    if (event.data.type === 'SESSION_REVOKED') {
      this.close();
    }
  }

  private handleResponse(response: ToolResponse): void {
    if (response.instanceId !== this.binding.instanceId) {
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.method !== response.method) {
      return;
    }
    if (!response.ok) {
      pending.reject(new ToolBridgeError(response.error.code, response.error.message));
      return;
    }
    const result = hostMethodResultSchemas[pending.method].safeParse(response.result ?? null);
    if (!result.success) {
      pending.reject(new ToolBridgeError('INVALID_RESPONSE', 'Оболочка вернула некорректный ответ'));
      return;
    }
    pending.resolve(result.data);
  }

  private close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    for (const pending of [...this.pending.values()]) {
      pending.reject(new ToolBridgeError('SESSION_CLOSED', 'Связь с оболочкой закрыта'));
    }
    this.listeners.clear();
    this.port.onmessage = null;
    this.port.close();
  }
}

export interface AutosaveOptions {
  schemaVersion: number;
  getState: () => JsonValue;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export interface Autosave {
  /** Marks state as changed; the save happens after the debounce. */
  schedule(): void;
  /** Saves pending changes now and waits for every save in flight. */
  flush(): Promise<void>;
  dispose(): void;
}

/**
 * Debounced state saving with a single save in flight. The host learns about unsaved changes through
 * `lifecycle.setDirty`, so it can warn before the user leaves the page.
 */
export function createAutosave(client: ToolHostClient, options: AutosaveOptions): Autosave {
  const debounceMs = options.debounceMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let reportedDirty = false;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const reportDirty = (value: boolean) => {
    if (reportedDirty === value || client.closed) {
      return;
    }
    reportedDirty = value;
    void client.request('lifecycle.setDirty', { dirty: value }).catch(() => {});
  };

  const save = async (): Promise<void> => {
    while (inFlight) {
      await inFlight;
    }
    if (!dirty || disposed || client.closed) {
      return;
    }
    dirty = false;

    let current: Promise<void>;
    try {
      const state = options.getState();
      current = client
        .request('state.save', { state, schemaVersion: options.schemaVersion })
        .then(
          () => undefined,
          (error: unknown) => {
            dirty = true;
            options.onError?.(error);
          },
        );
    } catch (error) {
      dirty = true;
      options.onError?.(error);
      return;
    }

    inFlight = current;
    await current;
    if (inFlight === current) {
      inFlight = null;
    }
    if (!dirty && !timer) {
      reportDirty(false);
    }
  };

  return {
    schedule() {
      if (disposed) {
        return;
      }
      dirty = true;
      reportDirty(true);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        void save();
      }, debounceMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await save();
      while (inFlight) {
        await inFlight;
      }
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
