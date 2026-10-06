import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

const MARGIN = 10; // mm
const GAP = 4; // mm

/**
 * Renders every `[data-pdf]` block inside `root` onto A4 pages and saves a real .pdf file.
 * The page is forced to the light theme while capturing so the PDF is always readable on paper.
 */
export async function buildPdf(root: HTMLElement, filename: string): Promise<void> {
  const html = document.documentElement;
  const wasDark = html.classList.contains("dark");
  if (wasDark) html.classList.remove("dark");
  try {
    const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-pdf]")).filter((el) => !el.parentElement?.closest("[data-pdf]"));
    if (blocks.length === 0) throw new Error("Nothing to export yet.");
    const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const usableW = pageW - MARGIN * 2;
    const usableH = pageH - MARGIN * 2;
    let y = MARGIN;

    const shots: { canvas: HTMLCanvasElement; heading: boolean }[] = [];
    for (const el of blocks) {
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false, windowWidth: Math.max(el.scrollWidth, 900) });
      if (canvas.width > 0 && canvas.height > 0) shots.push({ canvas, heading: /^H[1-3]$/.test(el.tagName) });
    }
    const hOf = (c: HTMLCanvasElement) => (c.height * usableW) / c.width;

    for (let i = 0; i < shots.length; i++) {
      const { canvas, heading } = shots[i];
      const mmH = hOf(canvas);
      // keep a heading together with the block that follows it
      const need = heading && shots[i + 1] ? mmH + Math.min(hOf(shots[i + 1].canvas), usableH - mmH) : mmH;

      if (mmH <= usableH) {
        if (y + need > pageH - MARGIN && y > MARGIN) {
          pdf.addPage();
          y = MARGIN;
        }
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", MARGIN, y, usableW, mmH);
        y += mmH + GAP;
      } else {
        // taller than a page: slice it. After a heading, start right below it instead of on a fresh page.
        const afterHeading = i > 0 && shots[i - 1].heading && pageH - MARGIN - y > 40;
        if (!afterHeading && y > MARGIN) {
          pdf.addPage();
          y = MARGIN;
        }
        const pxPerMm = canvas.width / usableW;
        let top = 0;
        while (top < canvas.height) {
          const roomMm = pageH - MARGIN - y;
          const h = Math.min(Math.floor(roomMm * pxPerMm), canvas.height - top);
          const part = document.createElement("canvas");
          part.width = canvas.width;
          part.height = h;
          const ctx = part.getContext("2d");
          if (!ctx) throw new Error("Canvas is not available in this browser.");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, part.width, part.height);
          ctx.drawImage(canvas, 0, top, canvas.width, h, 0, 0, canvas.width, h);
          pdf.addImage(part.toDataURL("image/jpeg", 0.92), "JPEG", MARGIN, y, usableW, h / pxPerMm);
          top += h;
          y += h / pxPerMm + GAP;
          if (top < canvas.height) {
            pdf.addPage();
            y = MARGIN;
          }
        }
      }
    }

    const pages = pdf.getNumberOfPages();
    pdf.setFontSize(8);
    pdf.setTextColor(120);
    for (let i = 1; i <= pages; i++) {
      pdf.setPage(i);
      pdf.text(`Auto ML report · page ${i} of ${pages}`, pageW / 2, pageH - 5, { align: "center" });
    }
    pdf.save(filename);
  } finally {
    if (wasDark) html.classList.add("dark");
  }
}
