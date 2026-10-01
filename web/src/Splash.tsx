declare const __APP_VERSION__: string;

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const SPINES = [
  { width: 12, height: 56, color: "#2f5d3a" },
  { width: 16, height: 68, color: "#a58e5f" },
  { width: 10, height: 48, color: "#8a3b2c" },
  { width: 14, height: 62, color: "#3b5b6b" },
];
const rise = (delay: number) => `ss-rise 2.5s ${EASE} ${delay}ms 1 both`;

export const SPLASH_MS = 2500;

export function Splash() {
  const [major, minor] = __APP_VERSION__.split(".");
  return (
    <div
      className="ss-motion pointer-events-none fixed inset-0 z-[60] flex flex-col items-center justify-center gap-7 bg-[#141110] text-[#fffaf6]"
      role="status"
      aria-label="Shelf Scanner is starting"
    >
      <div aria-hidden="true" className="relative flex h-[72px] items-end gap-1 pb-1.5">
        {SPINES.map((spine, index) => (
          <div
            key={spine.color}
            className="origin-bottom rounded-[2px]"
            style={{ width: spine.width, height: spine.height, background: spine.color, animation: rise(index * 90) }}
          />
        ))}
        <div className="origin-bottom" style={{ animation: rise(360) }}>
          <div
            className="h-[54px] w-3 origin-bottom-left rounded-[2px] bg-[#ff6b35]"
            style={{ animation: `ss-tip 2.5s ${EASE} 360ms 1 both` }}
          />
        </div>
        <div className="absolute -inset-x-1.5 bottom-0 h-1 origin-center rounded-[2px] bg-[#5a4632]" style={{ animation: `ss-shelf 2.5s ${EASE} 0ms 1 both` }} />
      </div>
      <div className="flex flex-col items-center gap-2" style={{ animation: `ss-fade 2.5s ${EASE} 0ms 1 both` }}>
        <h1 className="display m-0 text-[40px] leading-none">Shelf Scanner</h1>
        <p className="mt-2 text-sm text-[#a99283]">Point at a shelf. Find the best book on it.</p>
      </div>
      <p className="mono absolute inset-x-0 bottom-10 m-0 text-center text-xs tracking-[0.04em] text-[#a99283]">
        v{major}.{minor} | By Lakshman Turlapati
      </p>
    </div>
  );
}
