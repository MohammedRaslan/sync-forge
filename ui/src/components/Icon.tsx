const PATHS = {
  flow: 'M5 12h3m8 0h3M8 12a2 2 0 1 0 0 .01M16 12a2 2 0 1 0 0 .01M10 12h4',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5v14l11-7L7 5Z',
  stop: 'M7 7h10v10H7z',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4',
  trash: 'M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  check: 'M5 12l4 4 10-10',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  key: 'M15 7a4 4 0 1 1-3.9 4.9L4 19v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7Z',
  x: 'M6 6l12 12M18 6 6 18',
  rewind: 'M11 6 4 12l7 6V6Zm9 0-7 6 7 6V6Z',
  scale: 'M12 4v16M5 20h14M6 8l-3 7h6L6 8Zm12 0-3 7h6l-3-7ZM6 8h12',
  plug: 'M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5',
  download: 'M12 4v11m-5-5 5 5 5-5M5 20h14',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
