from __future__ import annotations

import csv
import io
import json
import sys
from pathlib import Path

from PIL import Image
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


PAGE_W, PAGE_H = landscape(A4)
MARGIN = 34
HEADER_H = 42
FOOTER_H = 22
INK = colors.HexColor("#17212b")
MUTED = colors.HexColor("#657585")
ACCENT = colors.HexColor("#12a8d4")
PANEL = colors.HexColor("#f4f7f9")


def read_metric_csv(path: Path, value_column: str = "pass8") -> dict[str, str]:
    with path.open("r", encoding="utf-8", newline="") as stream:
        rows = csv.DictReader(stream)
        result: dict[str, str] = {}
        for row in rows:
            column = value_column if value_column in row else "value"
            result[row["metric"]] = row[column]
        return result


def compressed_reader(path: Path, quality: int = 66) -> ImageReader:
    with Image.open(path) as source:
        image = source.convert("RGB")
        payload = io.BytesIO()
        image.save(payload, "JPEG", quality=quality, optimize=True, progressive=True)
    payload.seek(0)
    return ImageReader(payload)


def draw_header(pdf: canvas.Canvas, title: str, subtitle: str, page_number: int) -> None:
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 17)
    pdf.drawString(MARGIN, PAGE_H - MARGIN, title)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8.5)
    pdf.drawRightString(PAGE_W - MARGIN, PAGE_H - MARGIN + 1, subtitle)
    pdf.setStrokeColor(colors.HexColor("#d7e0e6"))
    pdf.line(MARGIN, PAGE_H - MARGIN - 10, PAGE_W - MARGIN, PAGE_H - MARGIN - 10)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 7.5)
    pdf.drawString(MARGIN, 13, "URDR 4.4 - Pass 8 Multiresolution Physical Diagnostics")
    pdf.drawRightString(PAGE_W - MARGIN, 13, str(page_number))


def draw_image(
    pdf: canvas.Canvas,
    path: Path,
    x: float,
    y: float,
    width: float,
    height: float,
    quality: int = 66,
) -> None:
    with Image.open(path) as source:
        ratio = min(width / source.width, height / source.height)
        draw_w = source.width * ratio
        draw_h = source.height * ratio
    image = compressed_reader(path, quality)
    pdf.setFillColor(PANEL)
    pdf.roundRect(x, y, width, height, 4, fill=1, stroke=0)
    pdf.drawImage(
        image,
        x + (width - draw_w) / 2,
        y + (height - draw_h) / 2,
        draw_w,
        draw_h,
        preserveAspectRatio=True,
        mask="auto",
    )


def image_page(
    pdf: canvas.Canvas,
    output: Path,
    filename: str,
    title: str,
    caption: str,
    subtitle: str,
    page_number: int,
) -> None:
    draw_header(pdf, title, subtitle, page_number)
    image_y = FOOTER_H + 35
    image_h = PAGE_H - HEADER_H - FOOTER_H - 72
    draw_image(pdf, output / filename, MARGIN, image_y, PAGE_W - MARGIN * 2, image_h)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8.5)
    pdf.drawString(MARGIN, FOOTER_H + 18, caption)
    pdf.showPage()


def summary_page(
    pdf: canvas.Canvas,
    refinement: dict[str, str],
    hydro: dict[str, str],
    performance: dict[str, str],
    terrain: dict[str, str],
    metadata: dict[str, object],
) -> None:
    draw_header(pdf, "Pass 8 Summary", "Locked fixture and measured results", 1)
    cards = [
        (
            "Conditioned channels",
            "38.33% -> 27.28%",
            "28.8% relative reduction",
        ),
        (
            "Maximum correction",
            "660.23 m -> 68.90 m",
            "hundreds-of-metres mismatch removed",
        ),
        (
            "Parent-grid curvature",
            f"{float(terrain['grid_boundary_curvature_ratio']):.1f} -> 1.055",
            "rectangular terrace concentration reduced",
        ),
        (
            "Sparse refinement",
            f"{int(refinement['refined_cells']):,} cells",
            f"{refinement['patch_count']} patches; L1 {refinement['level_1_patches']}, L2 {refinement['level_2_patches']}",
        ),
        (
            "Physical analysis",
            f"{float(performance['importance_field_ms']) + float(performance['patch_build_ms']) + float(performance['local_hydrology_ms']):,.0f} ms",
            f"peak combined scratch {int(performance['peak_memory_bytes']) / 1024 / 1024:.1f} MiB",
        ),
        (
            "Hydrology status",
            "PASS / core PARTIAL",
            f"{hydro['lacustrine_connector_cells']} lacustrine connectors remain",
        ),
    ]
    gap = 12
    card_w = (PAGE_W - MARGIN * 2 - gap * 2) / 3
    card_h = 92
    start_y = PAGE_H - MARGIN - 130
    for index, (label, value, note) in enumerate(cards):
        col = index % 3
        row = index // 3
        x = MARGIN + col * (card_w + gap)
        y = start_y - row * (card_h + gap)
        pdf.setFillColor(PANEL)
        pdf.roundRect(x, y, card_w, card_h, 6, fill=1, stroke=0)
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica-Bold", 8)
        pdf.drawString(x + 12, y + card_h - 19, label.upper())
        pdf.setFillColor(INK)
        pdf.setFont("Helvetica-Bold", 15)
        pdf.drawString(x + 12, y + card_h - 45, value)
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 7.7)
        pdf.drawString(x + 12, y + 15, note)

    table_y = 105
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(MARGIN, table_y + 105, "Fixture and invariants")
    rows = [
        ("Seed", str(metadata["seed"])),
        ("Map / extent", f"{metadata['map_id']} / {metadata['physical_extent_km'][0]} x {metadata['physical_extent_km'][1]} km"),
        ("Macro / physical", f"{metadata['macro_dimensions'][0]} x {metadata['macro_dimensions'][1]} / revision {metadata['physical_analysis_revision']}"),
        ("Planet-Region consistency", "PASS"),
        ("Natural deterministic hydrology", "PARTIAL - closed-depression persistence remains"),
    ]
    row_h = 18
    for index, (label, value) in enumerate(rows):
        y = table_y + 82 - index * row_h
        pdf.setStrokeColor(colors.HexColor("#dde5ea"))
        pdf.line(MARGIN, y - 5, PAGE_W - MARGIN, y - 5)
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 8)
        pdf.drawString(MARGIN + 4, y, label)
        pdf.setFillColor(INK)
        pdf.setFont("Helvetica-Bold", 8)
        pdf.drawString(MARGIN + 180, y, value)
    pdf.showPage()


def two_panel_page(
    pdf: canvas.Canvas,
    output: Path,
    left_name: str,
    right_name: str,
    title: str,
    subtitle: str,
    page_number: int,
) -> None:
    draw_header(pdf, title, subtitle, page_number)
    gap = 12
    panel_w = (PAGE_W - MARGIN * 2 - gap) / 2
    panel_y = FOOTER_H + 35
    panel_h = PAGE_H - HEADER_H - FOOTER_H - 72
    draw_image(pdf, output / left_name, MARGIN, panel_y, panel_w, panel_h)
    draw_image(pdf, output / right_name, MARGIN + panel_w + gap, panel_y, panel_w, panel_h)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8.5)
    pdf.drawString(MARGIN, FOOTER_H + 18, "Left: sparse refinement mask (macro / L1 / L2)")
    pdf.drawString(MARGIN + panel_w + gap, FOOTER_H + 18, "Right: remaining profile-conditioning heatmap")
    pdf.showPage()


def main() -> int:
    output = Path(sys.argv[1]).resolve()
    destination = output / "URDR-4.4-Pass-8-Multiresolution-Physical-Diagnostics-Compact.pdf"
    refinement = read_metric_csv(output / "pass8-refinement-metrics.csv", "value")
    hydro = read_metric_csv(output / "pass8-hydrology-reconciliation.csv")
    performance = read_metric_csv(output / "pass8-performance.csv")
    terrain_rows = read_metric_csv(output / "pass8-terrain-grid-artifact.csv", "before")
    metadata = json.loads((output / "pass8-metadata.json").read_text(encoding="utf-8"))

    pdf = canvas.Canvas(str(destination), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    pdf.setTitle("URDR 4.4 Pass 8 Multiresolution Physical Diagnostics")
    pdf.setAuthor("URDR diagnostics")
    fixture = f"seed {metadata['seed']} | {metadata['physical_extent_km'][0]} x {metadata['physical_extent_km'][1]} km"

    summary_page(pdf, refinement, hydro, performance, terrain_rows, metadata)
    image_page(pdf, output, "pass8-01-broad-elevation.png", "Broad Elevation", "Left: Pass 6/7 parent. Right: Pass 8 multiresolution physical field.", fixture, 2)
    image_page(pdf, output, "pass8-02-parent-grid-overlay.png", "192 x 120 Parent Grid Overlay", "Red grid: macro parent boundaries. Fine texture is deterministic physical refinement.", fixture, 3)
    image_page(pdf, output, "pass8-03-probe-A.png", "Terrain Probe A", "Representative terrain mismatch and refinement comparison.", fixture, 4)
    image_page(pdf, output, "pass8-04-probe-B.png", "Terrain Probe B", "Representative terrain mismatch and refinement comparison.", fixture, 5)
    image_page(pdf, output, "pass8-05-probe-C.png", "Terrain Probe C", "Representative terrain mismatch and refinement comparison.", fixture, 6)
    for index in range(5):
        image_page(
            pdf,
            output,
            f"pass8-{8 + index:02d}-river-{index + 1}.png",
            f"Deterministic River Fixture {index + 1}",
            "Pink: locked Pass 7 route. Cyan: Pass 8 route using the refined physical field.",
            fixture,
            7 + index,
        )
    image_page(pdf, output, "pass8-13-top-mismatch-corridors.png", "Top Mismatch Corridors", "Profiles compare parent support (pink) with refined terrain and resolved route (cyan).", fixture, 12)
    two_panel_page(pdf, output, "pass8-06-refinement-mask.png", "pass8-07-conditioning-heatmap.png", "Refinement Budget and Residual Conditioning", fixture, 13)
    pdf.save()
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
