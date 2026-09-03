import { ImageResponse } from 'next/og';

import { PWA_COLORS } from './palette';

export function createPredexAppIcon(size: 192 | 512) {
  const outline = Math.max(5, Math.round(size * 0.025));
  const eye = Math.round(size * 0.075);

  return new ImageResponse(
    (
      <div
        style={{
          alignItems: 'center',
          background: PWA_COLORS.background,
          display: 'flex',
          height: '100%',
          justifyContent: 'center',
          width: '100%',
        }}
      >
        <div
          style={{
            alignItems: 'center',
            background: PWA_COLORS.face,
            border: `${outline}px solid ${PWA_COLORS.ink}`,
            borderRadius: '28%',
            boxShadow: `0 ${Math.round(size * 0.035)}px 0 ${PWA_COLORS.shadow}`,
            display: 'flex',
            flexDirection: 'column',
            height: '72%',
            justifyContent: 'center',
            width: '72%',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: Math.round(size * 0.16),
              marginBottom: Math.round(size * 0.1),
            }}
          >
            <div
              style={{
                background: PWA_COLORS.ink,
                borderRadius: '50%',
                display: 'flex',
                height: eye,
                width: eye,
              }}
            />
            <div
              style={{
                background: PWA_COLORS.ink,
                borderRadius: '50%',
                display: 'flex',
                height: eye,
                width: eye,
              }}
            />
          </div>
          <div
            style={{
              background: PWA_COLORS.mouth,
              border: `${outline}px solid ${PWA_COLORS.ink}`,
              borderRadius: `0 0 ${size}px ${size}px`,
              display: 'flex',
              height: Math.round(size * 0.12),
              width: Math.round(size * 0.22),
            }}
          />
        </div>
      </div>
    ),
    {
      height: size,
      width: size,
    },
  );
}
