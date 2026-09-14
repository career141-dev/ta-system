/**
 * The scene at the top of the Database screen — spec §6D.1.
 *
 * Recruiter opens on a flat campus illustration. The purpose is not decoration:
 * an empty search screen with nothing but a box on it reads as broken, and this
 * gives the greeting something to sit on. Drawn in our own palette rather than
 * borrowed, and kept deliberately quiet so the box is still the loudest thing.
 */
export function Illustration() {
  return (
    <svg width={320} height={150} viewBox="0 0 320 150" role="img" aria-label="" className="mx-auto h-[150px] w-[320px]">
      <defs>
        <clipPath id="c141-sky">
          <path d="M40 150 A120 120 0 0 1 280 150 Z" />
        </clipPath>
      </defs>
      <path d="M40 150 A120 120 0 0 1 280 150 Z" fill="#eef4f1" />
      <g clipPath="url(#c141-sky)">
        <circle cx="238" cy="38" r="15" fill="#f2c94c" opacity="0.55" />
        <ellipse cx="88" cy="46" rx="26" ry="9" fill="#ffffff" />
        <ellipse cx="100" cy="40" rx="16" ry="8" fill="#ffffff" />
        <ellipse cx="236" cy="68" rx="22" ry="8" fill="#ffffff" opacity="0.85" />
        {/* The building */}
        <rect x="128" y="58" width="26" height="92" fill="#cfd8d4" />
        <rect x="166" y="58" width="26" height="92" fill="#cfd8d4" />
        <rect x="154" y="74" width="12" height="76" fill="#e2e8e5" />
        <rect x="140" y="34" width="40" height="40" rx="3" fill="#2f3d38" />
        <circle cx="160" cy="52" r="11" fill="#f7f8fa" />
        <path d="M160 52 L160 45 M160 52 L165 55" stroke="#2f3d38" strokeWidth="1.4" strokeLinecap="round" />
        <rect x="156" y="26" width="8" height="9" fill="#2f3d38" />
        {[64, 78, 92, 106, 120, 134].map((y) => (
          <g key={y}>
            <rect x="134" y={y} width="6" height="8" fill="#f7f8fa" opacity="0.9" />
            <rect x="143" y={y} width="6" height="8" fill="#f7f8fa" opacity="0.9" />
            <rect x="172" y={y} width="6" height="8" fill="#f7f8fa" opacity="0.9" />
            <rect x="181" y={y} width="6" height="8" fill="#f7f8fa" opacity="0.9" />
          </g>
        ))}
        {/* Trees */}
        <rect x="108" y="122" width="4" height="28" fill="#8a9a92" />
        <circle cx="110" cy="114" r="15" fill="#165b42" opacity="0.72" />
        <rect x="208" y="122" width="4" height="28" fill="#8a9a92" />
        <circle cx="210" cy="114" r="15" fill="#165b42" opacity="0.72" />
      </g>
    </svg>
  );
}
