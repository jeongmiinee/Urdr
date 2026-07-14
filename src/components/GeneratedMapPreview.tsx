import { useEffect, useRef, useState } from "react";
import type { GeneratedMapData } from "../model/world";
import type { GeneratedPreviewRaster } from "../generator/previewRaster";
import { drawGeneratedPreview, drawGeneratedPreviewOverlays, drawGeneratedSurfaceRegions } from "../generator/renderGenerated";

type Props = {
  data: GeneratedMapData | null;
  raster?: GeneratedPreviewRaster | null;
  showContours: boolean;
  showCoastline: boolean;
  onRendered?: () => void;
  onRenderError?: (message: string) => void;
};

export function GeneratedMapPreview({
  data,
  raster = null,
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
        if (raster && raster.width > 0 && raster.height > 0 && raster.pixels.length === raster.width * raster.height * 4) {
          canvas.width = raster.width;
          canvas.height = raster.height;
          context.imageSmoothingEnabled = true;
          const image = context.createImageData(raster.width, raster.height);
          image.data.set(raster.pixels);
          context.putImageData(image, 0, 0);
          drawGeneratedSurfaceRegions(canvas, data, 0.975);
          drawGeneratedPreviewOverlays(canvas, data, showContours, showCoastline);
        } else {
          const width = Math.max(320, Math.min(1024, containerSize.width || 960));
          const height = Math.max(180, Math.min(1024, containerSize.height || 540));
          drawGeneratedPreview(canvas, data, showContours, showCoastline, width, height);
        }
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
  }, [data, raster, showContours, showCoastline, containerSize.width, containerSize.height, onRendered, onRenderError]);

  return (
    <div ref={containerRef} className="generator-preview" data-preview-ready={data ? "true" : "false"}>
      {data ? <canvas ref={canvasRef} aria-label="생성된 지도 미리보기" /> : <div className="preview-placeholder">생성 결과가 여기에 표시됩니다.</div>}
      {renderError && <div className="preview-render-error">미리보기 표시 실패: {renderError}</div>}
    </div>
  );
}
