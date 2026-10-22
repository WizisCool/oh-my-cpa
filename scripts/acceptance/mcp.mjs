import { FAKE_CPA_MANAGEMENT_KEY } from '../fake-cpa.mjs';

/**
 * An external agent connects to the built console over MCP (Streamable HTTP under the
 * mount path) with the management key, sees the capability catalogue and reads through
 * to the gateway; a console session cookie is not an MCP credential.
 */
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '1' } } };

export async function runMcpAcceptance({ appURL, page, check }) {
  const endpoint = `${appURL}/api/mcp`;
  const call = async (message, authorization = `Bearer ${FAKE_CPA_MANAGEMENT_KEY}`) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: authorization },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: response.status, body, text };
  };

  const initialized = await call(INITIALIZE);
  check('an MCP client initializes with the management key', initialized.status === 200 && initialized.body?.result?.serverInfo?.name === 'oh-my-cpa',
    `status=${initialized.status} ${initialized.text.slice(0, 200)}`);

  const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
  check('the MCP catalogue offers the console capabilities', names.includes('keys_list') && names.includes('omc_operation_status'),
    `status=${listed.status} tools=${names.length}`);

  const read = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'keys_list', arguments: {} } });
  const readText = read.body?.result?.content?.[0]?.text ?? '';
  check('an MCP read reaches the gateway and succeeds', read.status === 200 && !read.body?.result?.isError && readText.includes('"status":"success"'),
    `status=${read.status} ${readText.slice(0, 200)}`);
  check('an MCP read does not return the management key', !read.text.includes(FAKE_CPA_MANAGEMENT_KEY));

  const withCookie = await page.request.post(endpoint, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    data: INITIALIZE,
  });
  check('a console session cookie is refused as an MCP credential', withCookie.status() === 401, `status=${withCookie.status()}`);
  const wrongKey = await call(INITIALIZE, 'Bearer acceptance-wrong-key');
  check('a wrong bearer key is refused', wrongKey.status === 401, `status=${wrongKey.status}`);
}
