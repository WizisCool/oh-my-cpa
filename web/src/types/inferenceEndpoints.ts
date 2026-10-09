/**
 * The inference surface of CPA a conversation is sent to. All three take the same conversation;
 * the server writes the body each one expects and reads its stream back into one set of events,
 * so the choice changes what reaches CPA and nothing about how an answer is drawn (ADR 0088).
 */
export type InferenceEndpoint = 'chat' | 'responses' | 'messages';

/** What an absent choice means, and what every conversation stored before the choice used. */
export const DEFAULT_INFERENCE_ENDPOINT: InferenceEndpoint = 'chat';

export const INFERENCE_ENDPOINT_PATHS: Record<InferenceEndpoint, string> = {
  chat: '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
};

export const INFERENCE_ENDPOINTS = Object.keys(INFERENCE_ENDPOINT_PATHS) as InferenceEndpoint[];

export function parseInferenceEndpoint(value: unknown): InferenceEndpoint | undefined {
  return (INFERENCE_ENDPOINTS as unknown[]).includes(value) ? value as InferenceEndpoint : undefined;
}
