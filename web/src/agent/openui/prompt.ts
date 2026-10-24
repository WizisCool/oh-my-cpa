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
  'Every response is OpenUI: a short answer is a Card with a single TextContent; a quantitative or multi-part answer composes charts, tables, metrics and tabs. Never answer in Markdown text outside the tool call.',
  'Figures come only from OMC capability results in this conversation. Never invent, estimate or pad a number, a model name, a key alias or a provider; if something was not returned, say it was not recorded.',
  `To plot or tabulate rows a capability returned, read them with Query("${DATA_ROWS_TOOL}", {data_ref: "<data_ref from data_sources>"}, {rows: []}) and pluck fields (rows.model, rows.total_tokens) into charts, tables and @Sum/@Count, instead of copying values into the program. Copy only a few headline figures by hand, exactly as returned.`,
  'Query and Mutation may also call any OMC capability declared to you as a function tool, with the same name and arguments, and get its result data. Query only read capabilities - for example to refetch usage when a $variable filter changes. A change goes in a Mutation run by a Button with @Run; a high-risk change still waits for the operator\'s approval in the console, so show the mutation\'s status rather than claiming success.',
  'Investigate with function tools first, then call present_openui once with the finished answer as the last step of the turn.',
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

/** The instructions the official assistant-ui integration gives the model, for OMC's options. */
export function omcOpenUIInstructions(capabilities: readonly OpenUICapability[]): string {
  return createOpenUIInstructions({ promptOptions: omcPromptOptions(capabilities) });
}
