import { requestResponse } from '../api/client';
import { createRunConnection } from './runConnection';

export const { reconnectRun, cancelRun, discoverRun } = createRunConnection(requestResponse);
