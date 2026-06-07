// The glossy caramel cube (§3.3). Isometric, palette gradients, a couple of
// specular highlights.
export function CaramelCube({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      role="img"
      aria-label="Cajeta caramel cube"
    >
      <defs>
        <linearGradient id="lg-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE6B8" />
          <stop offset="0.5" stopColor="#E0A85B" />
          <stop offset="1" stopColor="#C68A3E" />
        </linearGradient>
        <linearGradient id="lg-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#B97A2E" />
          <stop offset="1" stopColor="#7E4F1F" />
        </linearGradient>
        <linearGradient id="lg-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8A5A22" />
          <stop offset="1" stopColor="#5A3617" />
        </linearGradient>
      </defs>
      <polygon points="64,16 108,40 64,64 20,40" fill="url(#lg-top)" />
      <polygon points="20,40 64,64 64,112 20,88" fill="url(#lg-left)" />
      <polygon points="108,40 64,64 64,112 108,88" fill="url(#lg-right)" />
      <polyline
        points="24,42 64,64 104,42"
        fill="none"
        stroke="#FFE6B8"
        strokeOpacity="0.4"
        strokeWidth="1.5"
      />
      <ellipse
        cx="58"
        cy="36"
        rx="13"
        ry="6"
        fill="#FFFFFF"
        fillOpacity="0.55"
        transform="rotate(-26 58 36)"
      />
      <circle cx="82" cy="44" r="2.6" fill="#FFFFFF" fillOpacity="0.7" />
    </svg>
  );
}
