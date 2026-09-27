/**
 * A model the CPA gateway advertises for one client key.
 *
 * Shared by the Playground and the Agent because both select from the same directory, and a
 * second copy of this shape is how the two selectors would come to disagree about what a
 * "call point" is.
 */
export interface GatewayModelItem {
  id: string;
  call_point?: string;
  vision: string;
}

/**
 * The label a request must name, and the label the selector shows.
 *
 * CPA advertises a routing label (`call_point`) for a model that is reached through one; a model
 * without one is called by its own id. Showing the upstream id where the gateway expects a call
 * point would make the playground's diagnostics name a model the request never asked for.
 */
export function gatewayCallPointOf(item: GatewayModelItem): string {
  return item.call_point ?? item.id;
}
