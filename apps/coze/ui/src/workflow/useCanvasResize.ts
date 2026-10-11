import { useEffect, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";

/** Keep nodes visible when the inspector or the host app changes the available canvas space. */
export function useCanvasResize(container: RefObject<HTMLDivElement>) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!container.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView({ padding: 0.2, maxZoom: 1 }));
    });
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [container, fitView]);
}
