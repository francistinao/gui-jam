export interface NodeLike {
  readonly nodeType: number;
}

export interface TextLike extends NodeLike {
  data: string;
}

const TEXT_NODE = 3;

function isText(node: NodeLike): node is TextLike {
  return node.nodeType === TEXT_NODE;
}

export function textRuns(
  nodes: ArrayLike<NodeLike>,
  original: (node: TextLike) => string = (node) => node.data,
): TextLike[] {
  return Array.from(nodes)
    .filter(isText)
    .filter((node) => /\S/.test(original(node)));
}
