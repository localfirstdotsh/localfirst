import { createInterface } from 'node:readline';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { createWorkflow } from './project.mjs';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const receive = async () => {
  const item = await lines.next();
  // A bounded 64 KiB node output also needs space for the broker envelope.
  if (item.done || Buffer.byteLength(item.value) > 131072) throw new Error('protocol_input');
  return JSON.parse(item.value);
};
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const init = await receive();
if (init.type !== 'start' || !Array.isArray(init.node_ids) || init.node_ids.length > 16) throw new Error('protocol_start');
const executeStep = async id => {
  send({ type: 'step', id });
  const reply = await receive();
  if (reply.type !== 'result' || reply.id !== id) throw new Error('protocol_reply');
  return reply.output;
};
const graph = createWorkflow({ StateGraph, Annotation, START, END, executeStep, nodeIds: init.node_ids });
send({ type: 'ready' });
await graph.invoke({}, { recursionLimit: 32 });
send({ type: 'done' });
process.exit(0);
