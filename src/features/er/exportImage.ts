import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/react";
import { api } from "../../lib/api";

const PAD = 40;

/** Renders every table of the diagram (not just what's on screen) to a PNG or SVG file at `path`. */
export async function exportDiagram(canvas: HTMLElement, nodes: Node[], kind: "png" | "svg", path: string) {
  const viewport = canvas.querySelector<HTMLElement>(".react-flow__viewport");
  if (!viewport || nodes.length === 0) throw new Error("Nothing to export");
  const bounds = getNodesBounds(nodes);
  const width = Math.ceil(bounds.width + PAD * 2);
  const height = Math.ceil(bounds.height + PAD * 2);
  const vp = getViewportForBounds(bounds, width, height, 1, 1, 0);
  const options = {
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    width,
    height,
    pixelRatio: 2,
    // Editing controls (e.g. "+ column") aren't part of the picture.
    filter: (el: HTMLElement) => !(el instanceof HTMLElement && el.hasAttribute("data-export-skip")),
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(1)` },
  };
  const { toPng, toSvg } = await import("html-to-image"); // only needed when exporting
  if (kind === "png") {
    const url = await toPng(viewport, options);
    await api.writeBase64File(path, url.slice(url.indexOf(",") + 1));
  } else {
    const url = await toSvg(viewport, options);
    await api.writeTextFile(path, decodeURIComponent(url.slice(url.indexOf(",") + 1)));
  }
}
