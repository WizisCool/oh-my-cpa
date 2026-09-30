import { requestResponse } from '../api/client';
import { createRunConnection } from './runConnection';

export { isConnectionFailure } from './runConnection';
export const { currentRun, reconnectRun, cancelRun, discoverRun } = createRunConnection(requestResponse);
