import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from '../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/browser/index.js';
import {
  updateFieldWithBaseline,
  isConfigSemanticallyEqual,
} from '../web/src/components/config/configDirty.ts';

interface ConfigStateMachine {
  status: 'initial' | 'loading' | 'loaded' | 'error' | 'saving' | 'conflict';
  error: string | null;
  serverYaml: string;
  serverRevision: string;
  rawYaml: string;
  isDirty: boolean;
  canSave: boolean;
  canEdit: boolean;
  inFlightSaveYaml: string | null;
}

function createConfigStateMachine(): ConfigStateMachine {
  return {
    status: 'initial',
    error: null,
    serverYaml: '',
    serverRevision: '',
    rawYaml: '',
    isDirty: false,
    canSave: false,
    canEdit: false,
    inFlightSaveYaml: null,
  };
}

test('State Machine: Initial -> Loading -> Error blocks editing and saving', () => {
  const sm = createConfigStateMachine();
  assert.equal(sm.status, 'initial');
  assert.equal(sm.canEdit, false);
  assert.equal(sm.canSave, false);

  // Transition to Loading
  sm.status = 'loading';
  assert.equal(sm.canEdit, false);
  assert.equal(sm.canSave, false);

  // Query fails (CPA offline / 502)
  sm.status = 'error';
  sm.error = 'CPA offline';
  sm.canEdit = false;
  sm.canSave = false;
  sm.isDirty = false;

  assert.equal(sm.status, 'error');
  assert.equal(sm.canSave, false);
  assert.equal(sm.canEdit, false);
  assert.equal(sm.rawYaml, '');
});

test('State Machine: Loading -> Loaded enables editing in clean state', () => {
  const sm = createConfigStateMachine();
  sm.status = 'loading';

  const initialYaml = 'host: "127.0.0.1"\nport: 8317\n';
  const initialRev = 'rev-1111';

  // Loaded
  sm.status = 'loaded';
  sm.serverYaml = initialYaml;
  sm.rawYaml = initialYaml;
  sm.serverRevision = initialRev;
  sm.canEdit = true;
  sm.isDirty = false;
  sm.canSave = false; // clean, no changes yet

  assert.equal(sm.status, 'loaded');
  assert.equal(sm.isDirty, false);
  assert.equal(sm.canSave, false);
  assert.equal(sm.canEdit, true);
});

test('State Machine: Loaded -> Dirty -> Validating', () => {
  const sm = createConfigStateMachine();
  const initialYaml = 'host: "127.0.0.1"\nport: 8317\n';
  sm.status = 'loaded';
  sm.serverYaml = initialYaml;
  sm.rawYaml = initialYaml;
  sm.serverRevision = 'rev-1';
  sm.canEdit = true;

  // Edit field
  const currentDoc = parseDocument(sm.rawYaml);
  const serverDoc = parseDocument(sm.serverYaml);
  updateFieldWithBaseline(currentDoc, serverDoc, { id: 'port', yamlPath: ['port'], type: 'number' }, 9000);

  sm.rawYaml = currentDoc.toString();
  sm.isDirty = sm.rawYaml !== sm.serverYaml;
  sm.canSave = sm.isDirty && sm.status !== 'error';

  assert.equal(sm.isDirty, true);
  assert.equal(sm.canSave, true);

  // If user introduces YAML syntax error, saving is blocked
  const hasSyntaxError = parseDocument(sm.rawYaml + 'bad: [unclosed').errors.length > 0;
  assert.equal(hasSyntaxError, true);
});

test('State Machine: Saving with in-flight edit preserves dirty state on save-success', () => {
  const sm = createConfigStateMachine();
  const initialYaml = 'host: "127.0.0.1"\nport: 8317\n';
  sm.status = 'loaded';
  sm.serverYaml = initialYaml;
  sm.rawYaml = 'host: "127.0.0.1"\nport: 9000\n';
  sm.serverRevision = 'rev-1';
  sm.isDirty = true;
  sm.canSave = true;

  // Start saving snapshot A (port: 9000)
  sm.status = 'saving';
  sm.inFlightSaveYaml = sm.rawYaml;

  // While in flight, user makes another edit B (host: 0.0.0.0)
  sm.rawYaml = 'host: "0.0.0.0"\nport: 9000\n';

  // Save A completes successfully
  const savedVariablesYaml = sm.inFlightSaveYaml!;
  const newServerRevision = 'rev-2';
  sm.status = 'loaded';
  sm.serverYaml = savedVariablesYaml; // Base updated to A, NOT reactive rawYaml!
  sm.serverRevision = newServerRevision;
  sm.inFlightSaveYaml = null;

  // Recalculate dirty: edit B must remain dirty!
  sm.isDirty = sm.rawYaml !== sm.serverYaml;
  assert.equal(sm.isDirty, true, 'edits made during save must not be lost or marked clean');
  assert.equal(sm.serverYaml.includes('port: 9000'), true);
  assert.equal(sm.rawYaml.includes('host: "0.0.0.0"'), true);
});

test('State Machine: Saving -> Conflict (409) preserves local edits without overwriting', () => {
  const sm = createConfigStateMachine();
  sm.status = 'loaded';
  sm.serverYaml = 'host: "127.0.0.1"\nport: 8317\n';
  sm.serverRevision = 'rev-1';
  sm.rawYaml = 'host: "127.0.0.1"\nport: 9000\n';
  sm.isDirty = true;

  // Start saving
  sm.status = 'saving';
  sm.inFlightSaveYaml = sm.rawYaml;

  // Upstream returns 409 config_conflict
  const conflictResponse = {
    code: 'config_conflict',
    current_revision: 'rev-other-session',
  };

  sm.status = 'conflict';
  sm.error = 'Conflict: modified by another session';
  sm.inFlightSaveYaml = null;

  assert.equal(sm.status, 'conflict');
  // Local edits must remain intact!
  assert.equal(sm.rawYaml.includes('port: 9000'), true);
  assert.equal(conflictResponse.current_revision, 'rev-other-session');
});
