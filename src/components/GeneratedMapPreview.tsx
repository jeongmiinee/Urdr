import { useEffect, useRef, useState } from "react";
import type { GeneratedMapData } from "../model/world";
import {
  createGeneratedVectorSurfaceCanvas,
  drawGeneratedPreviewOverlays,
} from "../generator/renderGenerated";

type Props = {
  data: GeneratedMapData | null;
  showContours: boolean;
  showCoastline: boolean;
  onRendered?: () => void;
  onRenderError?: (message: string) => void;
};

export function GeneratedMapPreview({
  data,
  showContours,
  showCoastline,
  onRendered,
  onRenderError,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 960, height: 540 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 16 && rect.height > 16) {
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!data || !canvasRef.current) return;
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled || !canvasRef.current) return;
      try {
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("미리보기용 2D Canvas를 초기화하지 못했습니다.");
        if (!(data.surfaceRegions?.length ?? 0)) throw new Error("벡터 지형 데이터가 없습니다. 지도를 다시 생성해 주세요.");
        const availableWidth = Math.max(1, containerSize.width || 960);
        const availableHeight = Math.max(1, containerSize.height || 540);
        const mapAspect = Math.max(1e-6, data.worldWidth / Math.max(1e-6, data.worldHeight));
        const fittedWidth = Math.max(1, Math.floor(Math.min(availableWidth, availableHeight * mapAspect)));
        const fittedHeight = Math.max(1, Math.floor(fittedWidth / mapAspect));
        const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const width = Math.max(1, Math.round(fittedWidth * pixelRatio));
        const height = Math.max(1, Math.round(fittedHeight * pixelRatio));
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${fittedWidth}px`;
        canvas.style.height = `${fittedHeight}px`;
        context.imageSmoothingEnabled = true;
        context.drawImage(createGeneratedVectorSurfaceCanvas(data, width, height), 0, 0);
        drawGeneratedPreviewOverlays(canvas, data, showContours, showCoastline);
        setRenderError(null);
        onRendered?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? "미리보기 렌더링 오류");
        setRenderError(message);
        onRenderError?.(message);
      }
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [data, showContours, showCoastline, containerSize.width, containerSize.height, onRendered, onRenderError]);

  return (
    <div ref={containerRef} className="generator-preview" data-preview-ready={data ? "true" : "false"} data-fit-mode="contain">
      {data ? <canvas ref={canvasRef} aria-label="생성된 지도 미리보기" /> : <div className="preview-placeholder">생성 결과가 여기에 표시됩니다.</div>}
      {renderError && <div className="preview-render-error">미리보기 표시 실패: {renderError}</div>}
    </div>
  );
}
