export function stripPlan(width: number, height: number, overlap = 0.18) {
  const count = Math.max(2, Math.round((width / height) * 2));
  const stripW = width / (count - (count - 1) * overlap);
  const step = stripW * (1 - overlap);
  return { count, stripW, step, overlap };
}

export async function toStrips(file: Blob, overlap = 0.18, longEdge = 2000) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { count, stripW, step } = stripPlan(bmp.width, bmp.height, overlap);
  const strips: Blob[] = [];
  for (let i = 0; i < count; i++) {
    const sx = Math.min(i * step, Math.max(0, bmp.width - stripW));
    const scale = Math.min(1, longEdge / Math.max(stripW, bmp.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(stripW * scale)), Math.max(1, Math.round(bmp.height * scale)));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot draw the photo.");
    ctx.drawImage(bmp, sx, 0, stripW, bmp.height, 0, 0, canvas.width, canvas.height);
    strips.push(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
  }
  bmp.close();
  return strips;
}
