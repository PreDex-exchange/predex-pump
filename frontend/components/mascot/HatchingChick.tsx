import { useId, type SVGProps } from 'react';

import styles from './Mascot.module.css';

interface HatchingChickProps extends SVGProps<SVGSVGElement> {
  decorative?: boolean;
}

export function HatchingChick({
  className = '',
  decorative = false,
  ...props
}: HatchingChickProps) {
  return (
    <svg
      aria-hidden={decorative}
      className={`${styles.chick} ${className}`}
      role={decorative ? undefined : 'img'}
      viewBox="0 0 440 380"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {!decorative && <title>A cheerful chick hatching from an egg</title>}
      <ellipse cx="220" cy="340" fill="var(--ink)" opacity=".08" rx="152" ry="22" />

      <g fill="var(--brand)">
        <path
          d="M0,-11 C1.6,-3.5 3.5,-1.6 11,0 C3.5,1.6 1.6,3.5 0,11 C-1.6,3.5 -3.5,1.6 -11,0 C-3.5,-1.6 -1.6,-3.5 0,-11 Z"
          transform="translate(118,92) scale(1.15)"
        />
      </g>
      <g fill="var(--yes)">
        <path
          d="M0,-11 C1.6,-3.5 3.5,-1.6 11,0 C3.5,1.6 1.6,3.5 0,11 C-1.6,3.5 -3.5,1.6 -11,0 C-3.5,-1.6 -1.6,-3.5 0,-11 Z"
          transform="translate(366,116) scale(.82)"
        />
      </g>
      <circle cx="342" cy="82" fill="var(--reward)" r="4.5" />
      <circle cx="92" cy="150" fill="var(--no)" r="5" />

      <g transform="translate(300 66) rotate(16)">
        <path
          d="M0,44 L12,30 L24,44 L38,28 L52,44 L66,30 L78,44 C82,20 66,2 40,2 C16,2 -2,20 0,44 Z"
          fill="var(--surface-art)"
          stroke="var(--ink)"
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <path
          d="M20,14 q10,-8 24,-4"
          fill="none"
          stroke="var(--shell-highlight)"
          strokeLinecap="round"
          strokeWidth="3"
        />
      </g>

      <circle cx="220" cy="196" fill="var(--reward)" r="74" stroke="var(--ink)" strokeWidth="3.5" />
      <ellipse cx="196" cy="160" fill="var(--reward-highlight)" opacity=".75" rx="26" ry="17" />

      <g stroke="var(--ink)" strokeLinejoin="round" strokeWidth="3">
        <path
          d="M214,120 C206,104 214,96 221,100 C228,104 226,116 220,122 Z"
          fill="var(--reward-mid)"
        />
        <path
          d="M224,122 C222,106 231,100 236,106 C241,112 234,122 228,124 Z"
          fill="var(--reward-deep)"
        />
      </g>

      <ellipse cx="185" cy="198" fill="var(--brand)" opacity=".35" rx="9" ry="6.5" />
      <ellipse cx="255" cy="198" fill="var(--brand)" opacity=".35" rx="9" ry="6.5" />
      <circle cx="199" cy="182" fill="var(--ink)" r="9" />
      <circle cx="241" cy="182" fill="var(--ink)" r="9" />
      <circle cx="202" cy="179" fill="var(--surface)" r="3" />
      <circle cx="244" cy="179" fill="var(--surface)" r="3" />
      <path
        d="M206,196 L234,196 L220,210 Z"
        fill="var(--brand)"
        stroke="var(--ink)"
        strokeLinejoin="round"
        strokeWidth="2.5"
      />

      <path
        d="M120,214 L138,196 L156,214 L176,194 L196,214 L216,196 L236,214 L256,195 L276,214 L296,197 L320,214 C326,262 312,318 220,330 C128,318 114,262 120,214 Z"
        fill="var(--surface-art)"
        stroke="var(--ink)"
        strokeLinejoin="round"
        strokeWidth="3.5"
      />
      <path
        d="M150,238 q70,20 140,0"
        fill="none"
        stroke="var(--shell-line)"
        strokeLinecap="round"
        strokeWidth="4"
      />
      <path
        d="M150,206 C132,208 128,224 142,230 C150,232 157,224 156,214 Z"
        fill="var(--reward-shadow)"
        stroke="var(--ink)"
        strokeLinejoin="round"
        strokeWidth="3"
      />
      <path
        d="M290,206 C308,208 312,224 298,230 C290,232 283,224 284,214 Z"
        fill="var(--reward-shadow)"
        stroke="var(--ink)"
        strokeLinejoin="round"
        strokeWidth="3"
      />

      <g fill="var(--reward)">
        <path
          d="M0,-11 C1.6,-3.5 3.5,-1.6 11,0 C3.5,1.6 1.6,3.5 0,11 C-1.6,3.5 -3.5,1.6 -11,0 C-3.5,-1.6 -1.6,-3.5 0,-11 Z"
          transform="translate(392,244) scale(.75)"
        />
      </g>
      <g fill="var(--no)">
        <path
          d="M0,-11 C1.6,-3.5 3.5,-1.6 11,0 C3.5,1.6 1.6,3.5 0,11 C-1.6,3.5 -3.5,1.6 -11,0 C-3.5,-1.6 -1.6,-3.5 0,-11 Z"
          transform="translate(66,232) scale(.6)"
        />
      </g>
    </svg>
  );
}

export function CrackingEgg({
  progress,
  className = '',
  ...props
}: { progress: number } & SVGProps<SVGSVGElement>) {
  const clipId = useId();
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const fillHeight = 22 + clampedProgress * 0.62;

  return (
    <svg
      aria-label={`Egg is ${clampedProgress}% of the way to hatching`}
      className={`${styles.egg} ${className}`}
      role="img"
      viewBox="0 0 100 122"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <defs>
        <clipPath id={clipId}>
          <path d="M50 4C25 4 10 34 10 68c0 31 17 49 40 49s40-18 40-49C90 34 75 4 50 4Z" />
        </clipPath>
      </defs>
      <path
        d="M50 4C25 4 10 34 10 68c0 31 17 49 40 49s40-18 40-49C90 34 75 4 50 4Z"
        fill="var(--reward)"
      />
      <rect
        clipPath={`url(#${clipId})`}
        fill="var(--brand)"
        height={fillHeight}
        opacity=".18"
        width="100"
        x="0"
        y={122 - fillHeight}
      />
      {clampedProgress >= 20 && (
        <path
          d={
            clampedProgress >= 65
              ? 'M9 55 22 45l12 13 14-16 14 16 14-13 15 10'
              : 'M28 48 40 58l11-14 11 13 10-8'
          }
          fill="none"
          stroke="var(--ink)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="4"
        />
      )}
      <path
        d="M50 4C25 4 10 34 10 68c0 31 17 49 40 49s40-18 40-49C90 34 75 4 50 4Z"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="4"
      />
    </svg>
  );
}
