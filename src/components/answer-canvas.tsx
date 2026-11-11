"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export type CanvasHandle = { image: () => Promise<Blob> };
export const AnswerCanvas = forwardRef<CanvasHandle, { onDraw: (drawn: boolean) => void }>(function AnswerCanvas({ onDraw }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const clear = () => {
    const context = canvas.current?.getContext("2d");
    if (context) { context.fillStyle = "#fff"; context.fillRect(0, 0, 1000, 500); }
    onDraw(false);
  };
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (context) { context.fillStyle = "#fff"; context.fillRect(0, 0, 1000, 500); }
  }, []);
  useImperativeHandle(ref, () => ({ image: () => new Promise((resolve, reject) => {
    canvas.current?.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Unable to save drawing")), "image/png");
  }) }));
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [(event.clientX - bounds.left) * 1000 / bounds.width, (event.clientY - bounds.top) * 500 / bounds.height] as const;
  };
  return <div className="canvas-group"><canvas ref={canvas} width={1000} height={500} className="answer-canvas" aria-label="Write your answer" onPointerDown={(event) => {
    if (!event.isPrimary) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drawing.current = true;
    const context = event.currentTarget.getContext("2d");
    if (context) { const [x, y] = point(event); context.beginPath(); context.lineWidth = 3; context.lineCap = "round"; context.lineJoin = "round"; context.strokeStyle = "#171a18"; context.moveTo(x, y); context.lineTo(x + 0.1, y); context.stroke(); onDraw(true); }
  }} onPointerMove={(event) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext("2d"); const [x, y] = point(event); context?.lineTo(x, y); context?.stroke();
  }} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} />
    <button type="button" className="button button-small" onClick={clear}>Clear drawing</button><p className="field-hint">Use a mouse, stylus, or finger. You can use typed work instead.</p></div>;
});
