/** Creator reference: LangGraph schedules exactly the declared coordinator steps. */
export function createWorkflow({ StateGraph, Annotation, START, END, executeStep, nodeIds }) {
  const state = Annotation.Root({
    results: Annotation({ reducer: (previous, update) => ({ ...previous, ...update }), default: () => ({}) }),
  });
  const graph = new StateGraph(state);
  for (const id of nodeIds) graph.addNode(id, async () => ({ results: { [id]: await executeStep(id) } }));
  graph.addEdge(START, nodeIds[0]);
  for (let i = 1; i < nodeIds.length; i++) graph.addEdge(nodeIds[i - 1], nodeIds[i]);
  graph.addEdge(nodeIds.at(-1), END);
  return graph.compile();
}
