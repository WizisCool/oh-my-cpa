export interface ModelRequest {
  model: string;
  custom_body?: Record<string, unknown>;
}

/**
 * effectiveModel reports the model a turn's request will actually use.
 *
 * `custom_body` outranks the selector, so the selected call point is not always the model
 * that was called. Every surface that names the model - the turn label and the diagnostics
 * panel heading - reads this, so a turn is never labelled with a model it did not call.
 */
export function effectiveModel(request: ModelRequest): string {
  const override = request.custom_body?.model;
  return typeof override === 'string' && override.trim() ? override : request.model;
}
