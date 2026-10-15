import {
  BRIDGE_VERSION,
  IMPLEMENTED_CAPABILITIES,
  SUPPORTED_BRIDGE_VERSIONS,
  TOOLS_PROTOCOL,
  createProtocolToken,
  hostMethodParamsSchemas,
  isHostMethod,
  jsonByteLength,
  toolReadySchema,
  toolRequestEnvelopeSchema,
  type CloseReason,
  type HostConnectMessage,
  type HostErrorCode,
  type HostEvent,
  type HostHelloMessage,
  type HostMethodParams,
  type ToolBinding,
  type ToolCapability,
  type ToolManifest,
  type ToolRequestEnvelope,
} from './protocol';
import { applySnapshotSave, selectSnapshotForLoad } from './snapshots';

import type { ToolStateStore, WindowStateKey } from './storage';

/**
 * Host side of the bridge for one tool instance (one iframe load). Used by the TtRP shell and by the
 * dev host. Trust is established once, in the handshake (exact origin, source window, challenge,
 * expected app/version); after that the tool talks only through its MessagePort, and app/user/window
 * come from this binding, never from message payloads.
 */

export type ToolSessionFailure =
  | 'HANDSHAKE_TIMEOUT'
  | 'BRIDGE_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'RELOADED'
  | 'TOOL_FATAL';

export type ToolSessionStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'failed'; reason: ToolSessionFailure; detail?: string }
  | { kind: 'closed' };

/** The iframe as the session sees it; tests pass a fake. */
export interface ToolFrameTarget {
  /** Compared with `event.source` of window messages. */
  readonly source: unknown;
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

/** What the host knows about the tool it runs: manifest plus the host's own policy for it. */
export interface HostedTool {
  manifest: ToolManifest;
  /** Capabilities the host allows this tool; the session also intersects with the manifest request. */
  allowedCapabilities: readonly ToolCapability[];
  limits: { maxStateBytes: number };
}

/** Diagnostics for development hosts: what crossed the bridge. */
export type ToolHostTrace =
  | { kind: 'handshake'; step: 'HOST_HELLO' | 'TOOL_READY' | 'HOST_CONNECT' }
  | { kind: 'request'; method: string; ok: boolean; code?: HostErrorCode }
  | { kind: 'event'; type: HostEvent['type'] }
  | { kind: 'status'; status: ToolSessionStatus };

export interface ToolReportedError {
  code: string;
  message: string;
  fatal: boolean;
}

export interface ToolHostSessionOptions {
  entry: HostedTool;
  binding: ToolBinding;
  toolsOrigin: string;
  userId: string;
  storage: ToolStateStore;
  locale: string;
  visible: boolean;
  frame: ToolFrameTarget;
  onStatusChange?: (status: ToolSessionStatus) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onToolError?: (error: ToolReportedError) => void;
  onTrace?: (trace: ToolHostTrace) => void;
  timing?: { helloIntervalMs?: number; handshakeTimeoutMs?: number };
  now?: () => Date;
}

const DEFAULT_HELLO_INTERVAL_MS = 250;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const RATE_LIMIT_BURST = 60;
const RATE_LIMIT_PER_SECOND = 30;

class RequestRateLimiter {
  private tokens = RATE_LIMIT_BURST;
  private updatedAt = Date.now();

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(RATE_LIMIT_BURST, this.tokens + ((now - this.updatedAt) / 1000) * RATE_LIMIT_PER_SECOND);
    this.updatedAt = now;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

/** Requested by the manifest, allowed by the host and implemented by the SDK — nothing else. */
export function grantCapabilities(entry: HostedTool): ToolCapability[] {
  return [...new Set(entry.manifest.requestedCapabilities)].filter((capability) => (
    entry.allowedCapabilities.includes(capability) && IMPLEMENTED_CAPABILITIES.includes(capability)
  ));
}

class HostRequestError extends Error {
  constructor(readonly code: HostErrorCode, message: string) {
    super(message);
  }
}

export class ToolHostSession {
  private status: ToolSessionStatus = { kind: 'loading' };
  private readonly challenge = createProtocolToken();
  private readonly grantedCapabilities: ToolCapability[];
  private readonly rateLimiter = new RequestRateLimiter();
  private frameLoads = 0;
  private helloTraced = false;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private port: MessagePort | null = null;
  private visible: boolean;
  private dirty = false;
  private pendingClose: { id: string; done: () => void; promise: Promise<void> } | null = null;

  constructor(private readonly options: ToolHostSessionOptions) {
    this.visible = options.visible;
    this.grantedCapabilities = grantCapabilities(options.entry);
  }

  get currentStatus(): ToolSessionStatus {
    return this.status;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Every iframe `load`: the first starts the handshake, any later one invalidates this instance. */
  handleFrameLoad(): void {
    if (this.status.kind === 'closed' || this.status.kind === 'failed') {
      return;
    }
    this.frameLoads += 1;
    if (this.frameLoads > 1) {
      this.fail('RELOADED');
      return;
    }
    const timing = this.options.timing ?? {};
    this.sendHello();
    this.helloTimer = setInterval(() => this.sendHello(), timing.helloIntervalMs ?? DEFAULT_HELLO_INTERVAL_MS);
    this.handshakeTimer = setTimeout(
      () => this.fail('HANDSHAKE_TIMEOUT'),
      timing.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
  }

  /** Window `message` events; only TOOL_READY of this instance from the tools origin matters. */
  handleWindowMessage(event: Pick<MessageEvent, 'data' | 'origin' | 'source'>): void {
    if (this.status.kind !== 'loading' || this.frameLoads === 0) {
      return;
    }
    if (event.source !== this.options.frame.source || event.origin !== this.options.toolsOrigin) {
      return;
    }
    const parsed = toolReadySchema.safeParse(event.data);
    if (!parsed.success) {
      return;
    }
    const ready = parsed.data;
    if (ready.challenge !== this.challenge || ready.instanceId !== this.options.binding.instanceId) {
      return;
    }
    if (!SUPPORTED_BRIDGE_VERSIONS.includes(ready.bridgeVersion)) {
      this.fail('BRIDGE_MISMATCH', `bridge ${ready.bridgeVersion}`);
      return;
    }
    const { manifest } = this.options.entry;
    if (ready.appId !== manifest.id || ready.appVersion !== manifest.version) {
      this.fail('VERSION_MISMATCH', `${ready.appId}@${ready.appVersion}`);
      return;
    }
    this.options.onTrace?.({ kind: 'handshake', step: 'TOOL_READY' });
    this.connect();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    this.sendEvent({ type: 'VISIBILITY_CHANGED', instanceId: this.options.binding.instanceId, visible });
  }

  /**
   * Gives the tool a chance to flush unsaved data. Resolves on `lifecycle.closeReady` or at the deadline;
   * immediately when the tool is not connected.
   */
  requestClose(reason: CloseReason, deadlineMs: number): Promise<void> {
    if (this.status.kind !== 'ready' || !this.port) {
      return Promise.resolve();
    }
    if (this.pendingClose) {
      return this.pendingClose.promise;
    }
    const id = createProtocolToken();
    let done = () => {};
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => done(), deadlineMs);
      done = () => {
        clearTimeout(timer);
        if (this.pendingClose?.id === id) {
          this.pendingClose = null;
        }
        resolve();
      };
    });
    this.pendingClose = { id, done, promise };
    this.sendEvent({
      type: 'CLOSE_REQUESTED',
      instanceId: this.options.binding.instanceId,
      closeRequestId: id,
      deadlineMs,
      reason,
    });
    return promise;
  }

  /** Logout or user switch: the tool is told to stop without saving, then the port is closed. */
  revoke(): void {
    this.sendEvent({ type: 'SESSION_REVOKED', instanceId: this.options.binding.instanceId });
    this.shutdown({ kind: 'closed' });
  }

  dispose(): void {
    this.shutdown({ kind: 'closed' });
  }

  private connect(): void {
    this.stopHandshake();
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event: MessageEvent) => {
      void this.handleRequest(event.data);
    };
    const message: HostConnectMessage = {
      protocol: TOOLS_PROTOCOL,
      bridgeVersion: BRIDGE_VERSION,
      type: 'HOST_CONNECT',
      ...this.options.binding,
      challenge: this.challenge,
      grantedCapabilities: this.grantedCapabilities,
      locale: this.options.locale,
      visible: this.visible,
    };
    this.options.frame.postMessage(message, this.options.toolsOrigin, [channel.port2]);
    this.options.onTrace?.({ kind: 'handshake', step: 'HOST_CONNECT' });
    this.setStatus({ kind: 'ready' });
  }

  private sendHello(): void {
    const message: HostHelloMessage = {
      protocol: TOOLS_PROTOCOL,
      bridgeVersion: BRIDGE_VERSION,
      type: 'HOST_HELLO',
      ...this.options.binding,
      challenge: this.challenge,
    };
    try {
      this.options.frame.postMessage(message, this.options.toolsOrigin);
    } catch {
      // The frame is navigating; the next attempt or the timeout handles it.
    }
    if (!this.helloTraced) {
      this.helloTraced = true;
      this.options.onTrace?.({ kind: 'handshake', step: 'HOST_HELLO' });
    }
  }

  private sendEvent(event: HostEvent): void {
    if (this.status.kind === 'ready' && this.port) {
      this.port.postMessage(event);
      this.options.onTrace?.({ kind: 'event', type: event.type });
    }
  }

  private async handleRequest(data: unknown): Promise<void> {
    if (!this.port || this.status.kind !== 'ready') {
      return;
    }
    const envelope = toolRequestEnvelopeSchema.safeParse(data);
    if (!envelope.success || envelope.data.instanceId !== this.options.binding.instanceId) {
      return;
    }
    const request = envelope.data;

    try {
      if (!this.rateLimiter.take()) {
        throw new HostRequestError('LIMIT_EXCEEDED', 'Слишком много запросов');
      }
      if (!isHostMethod(request.method)) {
        throw new HostRequestError('UNSUPPORTED_METHOD', `Метод ${request.method} не поддерживается`);
      }
      this.respond(request, { ok: true, result: await this.dispatch(request) });
    } catch (error) {
      const failure = error instanceof HostRequestError
        ? error
        : new HostRequestError('INTERNAL_ERROR', 'Внутренняя ошибка оболочки');
      this.respond(request, { ok: false, error: { code: failure.code, message: failure.message } });
    }
  }

  private async dispatch(request: ToolRequestEnvelope): Promise<unknown> {
    switch (request.method) {
      case 'state.load':
        this.parseParams('state.load', request.params);
        this.requireCapability('LOCAL_STATE');
        return this.loadState();
      case 'state.save':
        this.requireCapability('LOCAL_STATE');
        return this.saveState(this.parseParams('state.save', request.params));
      case 'lifecycle.setDirty': {
        const { dirty } = this.parseParams('lifecycle.setDirty', request.params);
        this.setDirty(dirty);
        return null;
      }
      case 'lifecycle.closeReady': {
        const { closeRequestId } = this.parseParams('lifecycle.closeReady', request.params);
        const pending = this.pendingClose;
        if (pending?.id === closeRequestId) {
          // Answer first, then let the host close: closing usually disposes this session at once.
          setTimeout(() => pending.done(), 0);
        }
        return null;
      }
      case 'lifecycle.reportError': {
        const report = this.parseParams('lifecycle.reportError', request.params);
        this.options.onToolError?.(report);
        if (report.fatal) {
          // Answer first (the response is posted after this returns), then stop: the failure closes the port.
          setTimeout(() => this.fail('TOOL_FATAL', report.code), 0);
        }
        return null;
      }
      default:
        throw new HostRequestError('UNSUPPORTED_METHOD', `Метод ${request.method} не поддерживается`);
    }
  }

  private parseParams<M extends keyof typeof hostMethodParamsSchemas>(method: M, params: unknown): HostMethodParams<M> {
    const parsed = hostMethodParamsSchemas[method].safeParse(params);
    if (!parsed.success) {
      throw new HostRequestError('INVALID_REQUEST', 'Некорректные параметры запроса');
    }
    return parsed.data as HostMethodParams<M>;
  }

  private requireCapability(capability: ToolCapability): void {
    if (!this.grantedCapabilities.includes(capability)) {
      throw new HostRequestError('CAPABILITY_DENIED', `Нет разрешения ${capability}`);
    }
  }

  private stateKey(): WindowStateKey {
    return {
      userId: this.options.userId,
      appId: this.options.entry.manifest.id,
      windowId: this.options.binding.windowId,
    };
  }

  private async loadState() {
    try {
      const stored = await this.options.storage.loadWindowState(this.stateKey());
      return selectSnapshotForLoad(stored, this.options.entry.manifest.storageSchemaVersion);
    } catch {
      throw new HostRequestError('STORAGE_UNAVAILABLE', 'Локальное хранилище недоступно');
    }
  }

  private async saveState(params: HostMethodParams<'state.save'>) {
    if (params.schemaVersion > this.options.entry.manifest.storageSchemaVersion) {
      throw new HostRequestError('INVALID_REQUEST', 'Схема данных новее, чем объявлена в манифесте');
    }
    if (jsonByteLength(params.state) > this.options.entry.limits.maxStateBytes) {
      throw new HostRequestError('LIMIT_EXCEEDED', 'Состояние превышает допустимый размер');
    }
    const snapshot = {
      state: params.state,
      schemaVersion: params.schemaVersion,
      updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    try {
      await this.options.storage.updateWindowState(this.stateKey(), (stored) => applySnapshotSave(stored, snapshot));
    } catch {
      throw new HostRequestError('STORAGE_UNAVAILABLE', 'Локальное хранилище недоступно');
    }
    return { updatedAt: snapshot.updatedAt };
  }

  private respond(
    request: ToolRequestEnvelope,
    outcome: { ok: true; result: unknown } | { ok: false; error: { code: HostErrorCode; message: string } },
  ): void {
    if (this.status.kind !== 'ready') {
      return;
    }
    this.port?.postMessage({
      type: 'RESPONSE',
      instanceId: this.options.binding.instanceId,
      requestId: request.requestId,
      method: request.method,
      ...outcome,
    });
    this.options.onTrace?.({
      kind: 'request',
      method: request.method,
      ok: outcome.ok,
      code: outcome.ok ? undefined : outcome.error.code,
    });
  }

  private setDirty(dirty: boolean): void {
    if (this.dirty === dirty) {
      return;
    }
    this.dirty = dirty;
    this.options.onDirtyChange?.(dirty);
  }

  private setStatus(status: ToolSessionStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
    this.options.onTrace?.({ kind: 'status', status });
  }

  private fail(reason: ToolSessionFailure, detail?: string): void {
    if (this.status.kind === 'ready') {
      // A tool that is still running must stop saving: its instance is no longer trusted.
      this.sendEvent({ type: 'SESSION_REVOKED', instanceId: this.options.binding.instanceId });
    }
    this.shutdown({ kind: 'failed', reason, detail });
  }

  private stopHandshake(): void {
    if (this.helloTimer) {
      clearInterval(this.helloTimer);
      this.helloTimer = null;
    }
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private shutdown(status: ToolSessionStatus): void {
    if (this.status.kind === 'closed' || this.status.kind === 'failed') {
      return;
    }
    this.stopHandshake();
    this.pendingClose?.done();
    if (this.port) {
      this.port.onmessage = null;
      this.port.close();
      this.port = null;
    }
    this.setDirty(false);
    this.setStatus(status);
  }
}
