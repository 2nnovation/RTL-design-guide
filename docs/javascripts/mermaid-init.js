mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
});

document$.subscribe(async () => {
  const diagrams = [...document.querySelectorAll(".mermaid")].map(
    (originalNode) => {
      const source = originalNode.textContent;
      let renderNode = originalNode;

      if (originalNode.tagName === "PRE") {
        renderNode = document.createElement("div");
        renderNode.className = "mermaid";
        renderNode.textContent = source;
        originalNode.replaceWith(renderNode);
      }

      return { renderNode, source };
    },
  );

  const validDiagrams = [];

  for (const diagram of diagrams) {
    try {
      await mermaid.parse(diagram.source);
      validDiagrams.push(diagram);
    } catch (error) {
      console.error(
        "Mermaid parse failed:",
        JSON.stringify({
          name: error?.name,
          message: error?.message,
          hash: error?.hash,
          stack: error?.stack,
        }),
        diagram.source,
      );
      diagram.renderNode.textContent = diagram.source;
    }
  }

  try {
    await mermaid.run({
      nodes: validDiagrams.map(({ renderNode }) => renderNode),
    });
  } catch (error) {
    console.error("Mermaid render failed:", error);
  }
});
