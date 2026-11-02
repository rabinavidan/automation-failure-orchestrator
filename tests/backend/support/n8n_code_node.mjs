// Executes one n8n Code node from a workflow JSON file, for the pytest drift tests.
// The node's JavaScript is the system under test; this only supplies n8n's `$input` and `$()`.
//
//   node n8n_code_node.mjs <workflow.json> <node name>   (stdin: {"input": {...}, "nodes": {...}})
// Prints the node's returned items as JSON, or {"error": "..."} with exit code 1.
import { readFileSync } from 'node:fs';

const [, , workflowPath, nodeName] = process.argv;
const workflow = JSON.parse(readFileSync(workflowPath, 'utf-8'));
const node = workflow.nodes.find((n) => n.name === nodeName);
if (!node) {
  console.log(JSON.stringify({ error: `node not found: ${nodeName}` }));
  process.exit(1);
}
const { input = {}, nodes = {} } = JSON.parse(readFileSync(0, 'utf-8') || '{}');
const $input = { first: () => ({ json: input }), all: () => [{ json: input }] };
const $ = (name) => ({ first: () => ({ json: nodes[name] ?? {} }) });
const code = node.parameters.jsCode ?? node.parameters.functionCode;
const quietConsole = { log: () => {}, warn: () => {}, error: () => {} };
try {
  const items = new Function('$input', '$', 'console', code)($input, $, quietConsole);
  console.log(JSON.stringify(items));
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}
