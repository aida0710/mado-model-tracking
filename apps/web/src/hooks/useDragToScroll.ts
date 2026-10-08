import { useRef, type MouseEvent, type PointerEvent } from 'react';

// A press that moves less than this is still a click on the node under it.
const DRAG_THRESHOLD_PX = 4;

/**
 * Lets a mouse drag scroll an overflowing element, as touch already does natively. Spread the
 * returned handlers on the scrolling element; a drag does not also follow the link under it.
 */
export function useDragToScroll<Element extends HTMLElement>() {
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(
    null,
  );
  const wasDragged = useRef(false);
  return {
    onPointerDown(event: PointerEvent<Element>) {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      const element = event.currentTarget;
      drag.current = {
        x: event.clientX,
        y: event.clientY,
        left: element.scrollLeft,
        top: element.scrollTop,
        moved: false,
      };
      wasDragged.current = false;
    },
    onPointerMove(event: PointerEvent<Element>) {
      const start = drag.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      start.moved = true;
      event.currentTarget.scrollLeft = start.left - dx;
      event.currentTarget.scrollTop = start.top - dy;
    },
    onPointerUp() {
      wasDragged.current = drag.current?.moved ?? false;
      drag.current = null;
    },
    onPointerLeave() {
      drag.current = null;
    },
    onClickCapture(event: MouseEvent<Element>) {
      if (!wasDragged.current) return;
      wasDragged.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
