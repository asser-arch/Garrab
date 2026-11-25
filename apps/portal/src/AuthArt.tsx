/**
 * Sign-in page illustration: the hand-drawn try-on scene from the garrabb.com hero (a shopper taking a
 * selfie in a dress, a man waving next to a lamp), drawn in paper lines on the forest panel. The dress
 * changes colour every few seconds, as if being tried on. Decorative only.
 */
export function AuthArt() {
  const dress = "M170 142 C180 149 200 149 210 142 L216 172 C228 240 240 320 248 382 C210 392 170 392 132 382 C140 320 152 240 164 172 Z";
  const shirt = "M366 142 C382 134 418 134 434 142 L442 182 L432 186 L436 252 L364 252 L368 186 L358 182 Z";
  return (
    <svg className="auth-art" viewBox="100 40 470 380" aria-hidden="true" focusable="false">
      <g className="ink">
        <path d="M110 410 C220 406 440 414 560 409" />
        <ellipse className="rug" cx="300" cy="414" rx="190" ry="14" />
        <ellipse cx="300" cy="414" rx="190" ry="14" />
        <g className="her">
          <path className="dress" d={dress} />
          <path d={dress} />
          <path d="M166 172 C176 178 204 178 216 172 M150 290 C176 296 210 296 236 290" />
          <path d="M176 388 L174 406 L160 408 M204 388 L206 406 L220 408 M166 150 C150 180 144 220 150 262" />
          <circle className="solid" cx="191" cy="60" r="12" />
          <ellipse className="skin" cx="190" cy="100" rx="24" ry="28" />
          <path className="solid" d="M166 100 C164 70 216 68 214 98 C204 84 180 84 166 100 Z" />
          <circle className="solid" cx="182" cy="104" r="2.2" />
          <circle className="solid" cx="198" cy="104" r="2.2" />
          <path d="M184 115 C188 118 193 118 196 115 M190 128 L190 141" />
          <g className="selfie">
            <path d="M210 150 C232 168 244 178 246 150 L248 128" />
            <rect className="phone" x="236" y="92" width="24" height="40" rx="5" />
          </g>
        </g>
        <g className="him">
          <path className="solid" d="M364 250 L436 250 L432 404 L410 404 L400 296 L390 404 L368 404 Z" />
          <path d="M368 404 L350 408 M432 404 L450 408" />
          <path className="shirt" d={shirt} />
          <path d={shirt} />
          <path d="M388 138 L400 156 L412 138 M400 156 L400 246 M360 184 C352 210 350 236 354 262" />
          <g className="wave">
            <path d="M438 182 C452 166 462 150 464 128" />
            <path className="skin" d="M456 128 C450 112 456 100 464 104 C468 92 478 96 476 108 C482 108 482 122 472 128 Z" />
          </g>
          <ellipse className="skin" cx="400" cy="98" rx="25" ry="29" />
          <path className="solid" d="M375 96 C370 62 430 62 425 94 C418 82 404 86 398 78 C392 88 384 88 375 96 Z" />
          <circle className="solid" cx="391" cy="102" r="2.2" />
          <circle className="solid" cx="409" cy="102" r="2.2" />
          <path d="M392 114 C397 118 403 118 408 114 M400 127 L400 137" />
        </g>
        <path className="shade" d="M496 172 L544 172 L534 128 L506 128 Z" />
        <path d="M496 172 L544 172 L534 128 L506 128 Z M520 172 L520 404" />
        <ellipse cx="520" cy="406" rx="22" ry="5" />
      </g>
    </svg>
  );
}
