import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

const HIDE_MS = 400;

/**
 * Fixed-position hover tooltip (portal).
 * Stays open while pointer is on anchor OR tooltip so you can move in and scroll.
 */
export default function HoverFixedTooltip({
  content,
  children,
  className = '',
  tooltipClassName = '',
  placement = 'auto',
  as: Tag = 'span',
  tagProps = {},
}) {
  const anchorRef = useRef(null);
  const tooltipRef = useRef(null);
  const overAnchorRef = useRef(false);
  const overTooltipRef = useRef(false);
  const hideRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [style, setStyle] = useState({});

  const computePosition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 2;
    const maxW = Math.min(520, window.innerWidth - 16);
    const estH = 320;

    let top = r.bottom + gap;
    let left = r.left;
    let chosen = placement;

    if (placement === 'auto') {
      if (r.right + maxW + gap < window.innerWidth) chosen = 'right';
      else if (r.left - maxW - gap > 0) chosen = 'left';
      else if (r.bottom + estH > window.innerHeight && r.top - estH > 0) chosen = 'above';
      else chosen = 'below';
    }

    if (chosen === 'right') {
      left = r.right + gap;
      top = Math.max(8, Math.min(r.top, window.innerHeight - estH - 8));
    } else if (chosen === 'left') {
      left = Math.max(8, r.left - maxW - gap);
      top = Math.max(8, Math.min(r.top, window.innerHeight - estH - 8));
    } else if (chosen === 'above') {
      left = Math.max(8, Math.min(r.left, window.innerWidth - maxW - 8));
      top = Math.max(8, r.top - estH - gap);
    } else {
      left = Math.max(8, Math.min(r.left, window.innerWidth - maxW - 8));
      top = r.bottom + gap;
      if (top + estH > window.innerHeight - 8) {
        top = Math.max(8, r.top - estH - gap);
      }
    }

    setStyle({ top, left, maxWidth: maxW });
  }, [placement]);

  const syncVisibility = useCallback(() => {
    clearTimeout(hideRef.current);
    if (overAnchorRef.current || overTooltipRef.current) {
      computePosition();
      setVisible(true);
      return;
    }
    hideRef.current = setTimeout(() => setVisible(false), HIDE_MS);
  }, [computePosition]);

  const onAnchorEnter = useCallback(() => {
    overAnchorRef.current = true;
    syncVisibility();
  }, [syncVisibility]);

  const onAnchorLeave = useCallback(() => {
    overAnchorRef.current = false;
    syncVisibility();
  }, [syncVisibility]);

  const onTooltipEnter = useCallback(() => {
    overTooltipRef.current = true;
    syncVisibility();
  }, [syncVisibility]);

  const onTooltipLeave = useCallback(() => {
    overTooltipRef.current = false;
    syncVisibility();
  }, [syncVisibility]);

  useEffect(() => {
    if (!visible) return undefined;
    const onScroll = (e) => {
      if (tooltipRef.current?.contains(e.target)) return;
      computePosition();
    };
    const onResize = () => computePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [visible, computePosition]);

  useEffect(() => () => clearTimeout(hideRef.current), []);

  if (!content) return children;

  return (
    <>
      <Tag
        ref={anchorRef}
        className={className}
        onPointerEnter={onAnchorEnter}
        onPointerLeave={onAnchorLeave}
        {...tagProps}
      >
        {children}
      </Tag>
      {visible &&
        createPortal(
          <div
            ref={tooltipRef}
            className={`hover-fixed-tooltip ${tooltipClassName}`.trim()}
            style={{ position: 'fixed', zIndex: 10000, ...style }}
            onPointerEnter={onTooltipEnter}
            onPointerLeave={onTooltipLeave}
            role="tooltip"
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
}
