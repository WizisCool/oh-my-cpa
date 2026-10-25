import { createOpenUIInstructions, OPENUI_PRESENT_TOOL_NAME, OPENUI_PROMPT_TOOL_NAME, openuiToolDescriptions, openuiToolParameters } from '@openuidev/assistant-ui';
import type { PromptOptions, ToolSpec } from '@openuidev/react-lang';
import { openuiChatPromptOptions } from '@openuidev/react-ui/genui-lib/prompt-options';

/**
 * What the Agent's model is taught about OpenUI, built from the official chat library and the
 * official assistant-ui instructions.
 *
 * The server owns the system prompt, so this module is not sent from the browser: the generator
 * (`pnpm openui:prompt`) runs it under Node and writes the result into `internal/agent`, where the
 * runtime embeds it. The page imports the same module for its renderers, so the vocabulary the model
 * is taught and the one the renderer draws cannot drift apart without that generator's check
 * failing.
 */

export const PRESENT_TOOL = OPENUI_PRESENT_TOOL_NAME;
export const PROMPT_TOOL = OPENUI_PROMPT_TOOL_NAME;
export const TOOL_DESCRIPTIONS = openuiToolDescriptions;
/** The `ui` argument's description, as the official toolkit declares it. */
export const PARAMETER_DESCRIPTION = openuiToolParameters.shape.ui.description ?? '';

/**
 * The tool that reads rows an earlier capability call returned, by the `data_ref` that call's
 * result listed. It is how a chart or table plots the figures a capability returned rather than
 * the model's retelling of them: the server resolves the reference against the stored
 * conversation, so the rows are the ones the call returned and stay the same on a reload.
 */
export const DATA_ROWS_TOOL = 'data_rows';

const DATA_ROWS_SPEC: ToolSpec = {
  name: DATA_ROWS_TOOL,
  description: 'Rows of an earlier capability result in this conversation, named by a data_ref copied from that result\'s data_sources. Returns the rows with the scalar fields data_sources listed.',
  inputSchema: {
    type: 'object',
    properties: { data_ref: { type: 'string', description: 'A data_ref copied exactly from data_sources' } },
    required: ['data_ref'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      rows: { type: 'array', items: { type: 'object' } },
      fields: { type: 'array', items: { type: 'string' } },
    },
  },
  annotations: { readOnlyHint: true },
};

/**
 * The official chat library's rules, with the one that would have the model invent figures taken
 * out: an OMC answer is about the deployment's own data, and a plausible number is a wrong one.
 */
const OFFICIAL_RULES = (openuiChatPromptOptions.additionalRules ?? []).filter(rule => !/generate realistic\/plausible data/i.test(rule));

const OMC_RULES = [
  'Every asset in a program comes from OMC: never point an Image, a source or a background at an external address, because the console blocks it and the answer would show an empty box.',
  'Every response is OpenUI: a short answer is a Card holding the one thing asked for. Choose the composition the question needs rather than a fixed dashboard: a trend gets a time series and the window it covers, a comparison gets the entities side by side with their exact figures, a lookup gets the records and nothing else, a decision gets a form or a prepared change. Do not stack metrics, a chart, a table and tabs unless the answer genuinely needs each one.',
  'Never state the same number twice: a total in a metric tile is not repeated as a one-row chart, and a table that already lists the figures does not need a card above it repeating them. A supporting detail belongs in the table, a secondary section or an accordion, not beside the primary view.',
  'Figures come only from OMC capability results in this conversation. Never invent, estimate or pad a number, a model name, a key alias or a provider; if something was not returned, say it was not recorded.',
  `To plot or tabulate rows a capability returned, read them with Query("${DATA_ROWS_TOOL}", {data_ref: "<data_ref from data_sources>"}, {rows: []}) and pluck fields (rows.model, rows.total_tokens) into charts, tables and @Sum/@Count, instead of copying values into the program. Copy only a few headline figures by hand, exactly as returned.`,
  'Query and Mutation may also call any OMC capability declared to you as a function tool, with the same name and arguments, and get its result data. Query only read capabilities - for example to refetch usage when a $variable filter changes. A change goes in a Mutation run by a Button with @Run; a high-risk change still waits for the operator\'s approval in the console, so show the mutation\'s status rather than claiming success.',
  'Investigate with function tools first, then call present_openui once with the finished answer as the last step of the turn. Write the root statement first so the shell appears while the rest of the program streams.',
  'Asking the operator: ask_question is the console\'s own panel and the default - 1-4 questions, two to six short options each, and a typed answer always available. Draw a form with prompt_openui only when the question needs a shape the panel cannot express (a comparison put side by side, several typed fields whose layout carries meaning); build it from Form(name, Buttons([...]), fields) with one FormControl per field, a short label, the input, and the explanation as the control\'s hint, in one column with exactly one submit button. Never draw input controls into a present_openui answer, stack bare controls without a Form, number the labels, or pad a form with fields whose answer nothing uses.',
];

/** One capability a program may name, as `internal/agent/openui/capabilities.json` lists it. */
export interface OpenUICapability {
  name: string;
  description: string;
  permission: 'read' | 'write' | 'destructive';
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

/** A capability as the official prompt's tool section describes it. */
export function capabilityToolSpec(capability: OpenUICapability): ToolSpec {
  return {
    name: capability.name,
    description: capability.description,
    inputSchema: capability.input_schema,
    outputSchema: capability.output_schema,
    annotations: { readOnlyHint: capability.permission === 'read', destructiveHint: capability.permission === 'destructive' },
  };
}

/** The prompt options: the official chat options, with Query, Mutation and $variables taught. */
export function omcPromptOptions(capabilities: readonly OpenUICapability[]): PromptOptions {
  return {
    ...openuiChatPromptOptions,
    tools: [DATA_ROWS_SPEC, ...capabilities.map(capabilityToolSpec)],
    toolCalls: true,
    bindings: true,
    additionalRules: [...OFFICIAL_RULES, ...OMC_RULES],
  };
}

/** The official tool section's licence to invent figures, replaced with OMC's rule. */
const MOCK_DATA_RULE = /If the user asks for functionality that doesn't match any available tool, use realistic mock data instead of fabricating a tool call\./;

/**
 * The instructions the official assistant-ui integration gives the model, for OMC's options.
 *
 * The library's tool section carries one CRITICAL line telling the model to fill a gap with
 * realistic mock data. Filtering the library's *rules* does not reach it, and an OMC answer is
 * about the deployment's own data: a plausible number is a wrong one, and a chart of invented
 * figures is worse than saying the deployment did not record them.
 */
export function omcOpenUIInstructions(capabilities: readonly OpenUICapability[]): string {
  return createOpenUIInstructions({ promptOptions: omcPromptOptions(capabilities) }).replace(
    MOCK_DATA_RULE,
    'If the user asks for something no available tool answers, say what could not be read instead of inventing figures or a tool call.',
  );
}
