export function stripPlan(width: number, height: number, overlap = 0.18) {
  const count = Math.max(2, Math.round((width / height) * 2));
  const stripW = width / (count - (count - 1) * overlap);
  const step = stripW * (1 - overlap);
  return { count, stripW, step, overlap };
}

export type PhotoStrip = {
  blob: Blob;
  sx: number;
  stripW: number;
  imageWidth: number;
  imageHeight: number;
};

export type StripOptions = { overlap?: number; longEdge?: number; quality?: number };

type StripSource = CanvasImageSource & { width: number; height: number };

export function stripCrops(width: number, height: number, overlap = 0.18, longEdge = 1600) {
  const { count, stripW, step } = stripPlan(width, height, overlap);
  const scale = Math.min(1, longEdge / Math.max(stripW, height));
  return Array.from({ length: count }, (_, i) => ({
    sx: Math.min(i * step, Math.max(0, width - stripW)),
    stripW,
    outW: Math.max(1, Math.round(stripW * scale)),
    outH: Math.max(1, Math.round(height * scale)),
  }));
}

type Crop = ReturnType<typeof stripCrops>[number];

function drawCrop(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null, source: StripSource, crop: Crop) {
  if (!ctx) throw new Error("This browser cannot draw the photo.");
  ctx.drawImage(source, crop.sx, 0, crop.stripW, source.height, 0, 0, crop.outW, crop.outH);
}

async function encodeCrop(source: StripSource, crop: Crop, quality: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(crop.outW, crop.outH);
    drawCrop(canvas.getContext("2d"), source, crop);
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  const canvas = document.createElement("canvas");
  canvas.width = crop.outW;
  canvas.height = crop.outH;
  drawCrop(canvas.getContext("2d"), source, crop);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("This photo could not be encoded.");
  return blob;
}

export async function stripsFromCanvas(source: StripSource, { overlap = 0.18, longEdge = 1600, quality = 0.8 }: StripOptions = {}): Promise<PhotoStrip[]> {
  const { width, height } = source;
  return Promise.all(stripCrops(width, height, overlap, longEdge).map(async (crop) => ({
    blob: await encodeCrop(source, crop, quality),
    sx: crop.sx,
    stripW: crop.stripW,
    imageWidth: width,
    imageHeight: height,
  })));
}

export async function toStrips(file: Blob, overlap = 0.18, longEdge = 2000): Promise<PhotoStrip[]> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    return await stripsFromCanvas(bmp, { overlap, longEdge, quality: 0.85 });
  } finally {
    bmp.close();
  }
}
