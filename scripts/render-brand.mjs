import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

// Resting frame of the splash mark in web/src/Splash.tsx. The flex row is
// 80px wide, spines sit on the 6px bottom padding of a 72px box, and the
// orange spine finishes 10 degrees clockwise around its bottom-left corner.
const MARK = {
  shelf: { x: -6, y: 68, w: 92, h: 4 },
  spines: [
    { x: 0, y: 10, w: 12, h: 56, fill: "#2f5d3a" },
    { x: 16, y: -2, w: 16, h: 68, fill: "#a58e5f" },
    { x: 36, y: 18, w: 10, h: 48, fill: "#8a3b2c" },
    { x: 50, y: 4, w: 14, h: 62, fill: "#3b5b6b" },
  ],
  orange: { x: 68, y: 12, w: 12, h: 54, fill: "#ff6b35", pivotX: 68, pivotY: 66, rotation: 10 },
};

const BACKGROUND = "#141110";
const root = resolve(import.meta.dirname, "..");

function roundRect(x, y, w, h, r = 2) {
  const x2 = x + w;
  const y2 = y + h;
  return `M${x + r},${y} H${x2 - r} A${r},${r} 0 0 1 ${x2},${y + r} V${y2 - r} A${r},${r} 0 0 1 ${x2 - r},${y2} H${x + r} A${r},${r} 0 0 1 ${x},${y2 - r} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`;
}

function markSvg(fill) {
  const shelf = `<rect x="${MARK.shelf.x}" y="${MARK.shelf.y}" width="${MARK.shelf.w}" height="${MARK.shelf.h}" rx="2" fill="${fill ?? "#5a4632"}"/>`;
  const spines = MARK.spines
    .map((spine) => `<rect x="${spine.x}" y="${spine.y}" width="${spine.w}" height="${spine.h}" rx="2" fill="${fill ?? spine.fill}"/>`)
    .join("");
  const orange = MARK.orange;
  return `${shelf}${spines}<g transform="translate(${orange.pivotX} ${orange.pivotY}) rotate(${orange.rotation})"><rect x="0" y="-${orange.h}" width="${orange.w}" height="${orange.h}" rx="2" fill="${fill ?? orange.fill}"/></g>`;
}

function vectorPaths(fill) {
  const shelf = `    <path android:fillColor="${fill ?? "#5a4632"}" android:pathData="${roundRect(MARK.shelf.x, MARK.shelf.y, MARK.shelf.w, MARK.shelf.h)}"/>`;
  const spines = MARK.spines
    .map((spine) => `    <path android:fillColor="${fill ?? spine.fill}" android:pathData="${roundRect(spine.x, spine.y, spine.w, spine.h)}"/>`)
    .join("\n");
  const orange = MARK.orange;
  return `${shelf}\n${spines}\n    <group android:pivotX="${orange.pivotX}" android:pivotY="${orange.pivotY}" android:rotation="${orange.rotation}">\n      <path android:fillColor="${fill ?? orange.fill}" android:pathData="${roundRect(orange.x, orange.y, orange.w, orange.h)}"/>\n    </group>`;
}

// The mark is about 95 by 74. Scale it so the whole resting frame sits inside
// the 66dp adaptive-icon safe zone of a 108dp canvas.
const SCALE = 60 / 95.2;
const TRANSLATE_X = (108 - 60) / 2 - SCALE * -6;
const TRANSLATE_Y = (108 - 74 * SCALE) / 2 - SCALE * -2;

function vectorDrawable(paths) {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
  <group android:scaleX="${SCALE.toFixed(4)}" android:scaleY="${SCALE.toFixed(4)}" android:translateX="${TRANSLATE_X.toFixed(2)}" android:translateY="${TRANSLATE_Y.toFixed(2)}">
${paths}
  </group>
</vector>
`;
}

function wrapped(size, { background = false, round = false, markFill = null } = {}) {
  const inner = markSvg(markFill);
  const plate = background ? `<rect width="108" height="108" fill="${BACKGROUND}"/>` : "";
  const body = `${plate}<g transform="translate(${TRANSLATE_X.toFixed(2)} ${TRANSLATE_Y.toFixed(2)}) scale(${SCALE.toFixed(4)})">${inner}</g>`;
  const clipped = round
    ? `<defs><clipPath id="round"><circle cx="54" cy="54" r="54"/></clipPath></defs><g clip-path="url(#round)">${body}</g>`
    : body;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 108 108">${clipped}</svg>`;
}

function png(svg, file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, new Resvg(svg).render().asPng());
}

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -6 100 82" fill="none">
  ${markSvg()}
</svg>
`;
mkdirSync(resolve(root, "web/public"), { recursive: true });
writeFileSync(resolve(root, "web/public/logo.svg"), logo);

const res = resolve(root, "android/app/src/main/res");
writeFileSync(resolve(res, "drawable/ic_launcher_foreground.xml"), vectorDrawable(vectorPaths()));
writeFileSync(resolve(res, "drawable/ic_launcher_monochrome.xml"), vectorDrawable(vectorPaths("#ffffff")));

const densities = [
  ["mipmap-mdpi", 48],
  ["mipmap-hdpi", 72],
  ["mipmap-xhdpi", 96],
  ["mipmap-xxhdpi", 144],
  ["mipmap-xxxhdpi", 192],
];
for (const [folder, launcher] of densities) {
  png(wrapped(launcher), resolve(res, folder, "ic_launcher.png"));
  png(wrapped(launcher, { background: true, round: true }), resolve(res, folder, "ic_launcher_round.png"));
}

png(wrapped(192, { background: true }), resolve(root, "web/public/icon-192.png"));
png(wrapped(512, { background: true }), resolve(root, "web/public/icon-512.png"));
png(wrapped(512, { background: true }), resolve(root, "android/play-store-icon.png"));

const written = readFileSync(resolve(root, "web/public/logo.svg"), "utf8");
for (const color of ["#2f5d3a", "#a58e5f", "#8a3b2c", "#3b5b6b", "#ff6b35", "#5a4632"]) {
  if (!written.includes(color)) throw new Error(`logo is missing ${color}`);
}
console.log("brand assets written");
