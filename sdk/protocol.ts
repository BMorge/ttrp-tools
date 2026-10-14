import { z } from 'zod';

/**
 * Bridge protocol between the TtRP shell and an embedded tool (an iframe on the tools origin).
 * Both sides import this module and validate every incoming message at runtime:
 * TypeScript types alone are never trusted across the frame boundary.
 */

export const TOOLS_PROTOCOL = 'TTRP_TOOLS';
export const BRIDGE_VERSION = 1;
export const SUPPORTED_BRIDGE_VERSIONS: readonly number[] = [BRIDGE_VERSION];

export const TOOL_CAPABILITIES = [
  'LOCAL_STATE',
  'ASSETS',
  'FILES_IMPORT',
  'FILES_EXPORT',
  'ROOM_CONNECT',
  'CHARACTER_READ',
  'CHARACTER_SAVE',
] as const;
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/** Capabilities the shell can serve today; a tool never gets anything else, whatever the catalog says. */
export const IMPLEMENTED_CAPABILITIES: readonly ToolCapability[] = ['LOCAL_STATE'];

export const HOST_ERROR_CODES = [
  'CAPABILITY_DENIED',
  'INVALID_REQUEST',
  'UNSUPPORTED_METHOD',
  'LIMIT_EXCEEDED',
  'TIMEOUT',
  'SESSION_CLOSED',
  'STORAGE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

export const CLOSE_REASONS = ['USER_CLOSE', 'NAVIGATION'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

const toolIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const versionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/);
/** Instance, window, challenge and request ids: opaque URL-safe tokens. */
export const protocolTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export const toolCapabilitySchema = z.enum(TOOL_CAPABILITIES);

const windowSizeSchema = z.number().int().min(200).max(4000);

export const toolManifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: toolIdSchema,
  version: versionSchema,
  title: z.string().min(1).max(60),
  description: z.string().max(200),
  bridgeVersion: z.number().int().positive(),
  // Relative to the release root; segments without dots, so `..` cannot appear.
  entrypoint: z.string().regex(/^(\.\/)?[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.html$/),
  storageSchemaVersion: z.number().int().min(1),
  requestedCapabilities: z.array(toolCapabilitySchema),
  window: z.object({
    width: windowSizeSchema,
    height: windowSizeSchema,
    minWidth: windowSizeSchema,
    minHeight: windowSizeSchema,
    multipleInstances: z.boolean(),
  }).strict(),
}).strict();
export type ToolManifest = z.infer<typeof toolManifestSchema>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_JSON_DEPTH = 64;

/** Plain JSON data only: structured clone could otherwise carry Maps, Dates or typed arrays into storage. */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || depth >= MAX_JSON_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

export const jsonValueSchema = z.custom<JsonValue>((value) => isJsonValue(value), 'Ожидаются данные JSON');

export function jsonByteLength(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export const toolBindingSchema = z.object({
  instanceId: protocolTokenSchema,
  windowId: protocolTokenSchema,
  appId: toolIdSchema,
  appVersion: versionSchema,
});
export type ToolBinding = z.infer<typeof toolBindingSchema>;

const envelopeShape = {
  protocol: z.literal(TOOLS_PROTOCOL),
  bridgeVersion: z.number().int().positive(),
};

/** Host → tool via window.postMessage; re-sent with backoff until TOOL_READY arrives. */
export const hostHelloSchema = z.object({
  ...envelopeShape,
  ...toolBindingSchema.shape,
  type: z.literal('HOST_HELLO'),
  challenge: protocolTokenSchema,
}).strict();
export type HostHelloMessage = z.infer<typeof hostHelloSchema>;

/** Tool → host via window.parent.postMessage. App id and version come from the tool build. */
export const toolReadySchema = z.object({
  ...envelopeShape,
  type: z.literal('TOOL_READY'),
  challenge: protocolTokenSchema,
  instanceId: protocolTokenSchema,
  appId: toolIdSchema,
  appVersion: versionSchema,
}).strict();
export type ToolReadyMessage = z.infer<typeof toolReadySchema>;

/** Host → tool with exactly one transferred MessagePort; everything after it goes through the port. */
export const hostConnectSchema = z.object({
  ...envelopeShape,
  ...toolBindingSchema.shape,
  type: z.literal('HOST_CONNECT'),
  challenge: protocolTokenSchema,
  grantedCapabilities: z.array(toolCapabilitySchema),
  locale: z.string().min(2).max(35),
  visible: z.boolean(),
}).strict();
export type HostConnectMessage = z.infer<typeof hostConnectSchema>;

export const stateSnapshotSchema = z.object({
  state: jsonValueSchema,
  schemaVersion: z.number().int().min(1),
  updatedAt: z.string().datetime(),
}).strict();
export interface StateSnapshot {
  state: JsonValue;
  schemaVersion: number;
  updatedAt: string;
}

export const hostMethodParamsSchemas = {
  'state.load': z.object({}).strict(),
  'state.save': z.object({
    state: jsonValueSchema,
    schemaVersion: z.number().int().min(1),
  }).strict(),
  'lifecycle.setDirty': z.object({ dirty: z.boolean() }).strict(),
  'lifecycle.closeReady': z.object({ closeRequestId: protocolTokenSchema }).strict(),
  'lifecycle.reportError': z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    message: z.string().max(500),
    fatal: z.boolean(),
  }).strict(),
};

export type HostMethod = keyof typeof hostMethodParamsSchemas;
export type HostMethodParams<M extends HostMethod> = z.infer<(typeof hostMethodParamsSchemas)[M]>;

export interface HostMethodResults {
  'state.load': StateSnapshot | null;
  'state.save': { updatedAt: string };
  'lifecycle.setDirty': null;
  'lifecycle.closeReady': null;
  'lifecycle.reportError': null;
}
export type HostMethodResult<M extends HostMethod> = HostMethodResults[M];

export const hostMethodResultSchemas: { [M in HostMethod]: z.ZodType<HostMethodResults[M]> } = {
  'state.load': stateSnapshotSchema.nullable(),
  'state.save': z.object({ updatedAt: z.string().datetime() }).strict(),
  'lifecycle.setDirty': z.null(),
  'lifecycle.closeReady': z.null(),
  'lifecycle.reportError': z.null(),
};

export function isHostMethod(value: string): value is HostMethod {
  return Object.hasOwn(hostMethodParamsSchemas, value);
}

/** The method is checked separately so an unknown one gets UNSUPPORTED_METHOD rather than INVALID_REQUEST. */
export const toolRequestEnvelopeSchema = z.object({
  type: z.literal('REQUEST'),
  instanceId: protocolTokenSchema,
  requestId: protocolTokenSchema,
  method: z.string().min(1).max(64),
  params: z.unknown(),
}).strict();
export type ToolRequestEnvelope = z.infer<typeof toolRequestEnvelopeSchema>;

const responseShape = {
  type: z.literal('RESPONSE'),
  instanceId: protocolTokenSchema,
  requestId: protocolTokenSchema,
  method: z.string().min(1).max(64),
};

export const toolResponseSchema = z.union([
  z.object({ ...responseShape, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({
    ...responseShape,
    ok: z.literal(false),
    error: z.object({
      code: z.enum(HOST_ERROR_CODES),
      message: z.string().max(500),
    }).strict(),
  }).strict(),
]);
export type ToolResponse = z.infer<typeof toolResponseSchema>;

export const hostEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('VISIBILITY_CHANGED'),
    instanceId: protocolTokenSchema,
    visible: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('CLOSE_REQUESTED'),
    instanceId: protocolTokenSchema,
    closeRequestId: protocolTokenSchema,
    deadlineMs: z.number().int().min(0).max(60_000),
    reason: z.enum(CLOSE_REASONS),
  }).strict(),
  // Logout or user switch: the tool must not save anything; the host closes the port right after.
  z.object({
    type: z.literal('SESSION_REVOKED'),
    instanceId: protocolTokenSchema,
  }).strict(),
]);
export type HostEvent = z.infer<typeof hostEventSchema>;

export function createProtocolToken(): string {
  return crypto.randomUUID();
}
