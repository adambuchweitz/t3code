// oxlint-disable shadcn/no-raw-colors -- character art keeps its own palette in every theme.
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export type TotPose = "awake" | "working" | "needs" | "asleep";

const INK = "#1b1b22";
const WHITE = "#fff";
const stroke = {
  stroke: INK,
  strokeWidth: 2.2,
  strokeLinejoin: "round",
  strokeLinecap: "round",
} as const;

function Eyes(props: { x1: number; x2: number; y: number; pose: TotPose; r?: number; m?: number }) {
  const { x1, x2, y, pose, r = 6.5 } = props;
  const mouthY = props.m ?? y + 11;
  const mid = (x1 + x2) / 2;
  if (pose === "asleep") {
    return (
      <>
        <path d={`M${x1 - 5} ${y}q5 4 10 0M${x2 - 5} ${y}q5 4 10 0`} fill="none" {...stroke} />
        <path d={`M${mid - 2} ${mouthY}q2 2 4 0`} fill="none" {...stroke} />
      </>
    );
  }
  const radius = pose === "needs" ? r * 1.22 : r;
  const dy = pose === "working" ? radius * 0.42 : pose === "needs" ? -radius * 0.2 : 0;
  const dx = pose === "awake" ? 1.2 : 0;
  const pupil = radius * 0.56;
  const eye = (x: number) => (
    <>
      <circle cx={x} cy={y} r={radius} fill={WHITE} {...stroke} />
      <circle cx={x + dx} cy={y + dy} r={pupil} fill={INK} />
      <circle cx={x + dx + pupil * 0.35} cy={y + dy - pupil * 0.4} r={pupil * 0.3} fill={WHITE} />
    </>
  );
  return (
    <>
      {eye(x1)}
      {eye(x2)}
      {pose === "needs" ? (
        <ellipse cx={mid} cy={mouthY + 1} rx={3.4} ry={4.2} fill={INK} />
      ) : pose === "working" ? (
        <path d={`M${mid - 3} ${mouthY + 1}h6`} fill="none" {...stroke} />
      ) : (
        <path d={`M${mid - 4} ${mouthY}q4 4.5 8 0`} fill="none" {...stroke} />
      )}
    </>
  );
}

const Legs = ({
  fill,
  a = 30,
  b = 44,
  y = 64,
}: {
  fill: string;
  a?: number;
  b?: number;
  y?: number;
}) => (
  <>
    <rect x={a} y={y} width={8} height={10} rx={4} fill={fill} {...stroke} />
    <rect x={b} y={y} width={8} height={10} rx={4} fill={fill} {...stroke} />
  </>
);

function WaveArm({ fill, x, y }: { fill: string; x: number; y: number }) {
  const d = `M${x} ${y}Q${x + 9} ${y - 12} ${x + 7} ${y - 27}`;
  return (
    <>
      <path d={d} fill="none" stroke={INK} strokeWidth={8.5} strokeLinecap="round" />
      <path d={d} fill="none" stroke={fill} strokeWidth={4.5} strokeLinecap="round" />
      <circle cx={x + 7} cy={y - 30} r={4.8} fill={fill} {...stroke} />
    </>
  );
}

const Zz = ({ x, y }: { x: number; y: number }) => (
  <path
    d={`M${x} ${y}h7l-7 8h7M${x + 11} ${y - 11}h5l-5 6h5`}
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);

function Brace({ pose }: { pose: TotPose }) {
  const fill = pose === "asleep" ? "#7d97c9" : "#5b8cff";
  return (
    <>
      <path
        d="M14 21C8 21 8 25 8 29V37C8 41 6 43 3 43C6 43 8 45 8 49V57C8 61 8 65 14 65M66 21C72 21 72 25 72 29V37C72 41 74 43 77 43C74 43 72 45 72 49V57C72 61 72 65 66 65"
        fill="none"
        stroke={fill}
        strokeWidth={4.5}
        strokeLinecap="round"
      />
      <Legs fill={fill} />
      <rect x={18} y={22} width={44} height={46} rx={18} fill={fill} {...stroke} />
      <Eyes x1={31} x2={49} y={38} pose={pose} m={50} />
      {pose === "working" ? (
        <g transform="rotate(-5 40 54)">
          <rect x={29} y={47} width={22} height={19} rx={2.5} fill={WHITE} {...stroke} />
          <rect x={36} y={44} width={8} height={5} rx={1.5} fill="#c9ced8" {...stroke} />
          <path d="M33 54h14M33 59h10" stroke="#8d95a3" strokeWidth={1.8} strokeLinecap="round" />
        </g>
      ) : null}
      {pose === "needs" ? <WaveArm fill={fill} x={57} y={48} /> : null}
      {pose === "asleep" ? <Zz x={62} y={16} /> : null}
    </>
  );
}

function Nigiri({ pose }: { pose: TotPose }) {
  const rice = "#f7f1e3";
  return (
    <>
      <Legs fill={rice} />
      <rect x={15} y={31} width={50} height={36} rx={13} fill={rice} {...stroke} />
      <rect
        x={9}
        y={15}
        width={62}
        height={26}
        rx={12}
        fill={pose === "asleep" ? "#d9a48d" : "#f58b61"}
        {...stroke}
      />
      <path
        d="M20 20l9 16M34 18l9 18M48 18l9 18"
        stroke="#ffd6c2"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <Eyes x1={30} x2={50} y={50} pose={pose} r={5.8} m={60} />
      {pose === "working" ? (
        <>
          <rect x={29} y={55} width={22} height={13} rx={2.5} fill="#2b2d33" {...stroke} />
          <circle cx={40} cy={61.5} r={4} fill="#9fb4d0" {...stroke} />
        </>
      ) : null}
      {pose === "needs" ? <WaveArm fill={rice} x={61} y={54} /> : null}
      {pose === "asleep" ? <Zz x={66} y={8} /> : null}
    </>
  );
}

function Blocks({ pose }: { pose: TotPose }) {
  const top = pose === "asleep" ? "#c79aa8" : "#ff7b9c";
  return (
    <>
      <Legs fill="#ffc857" a={28} b={44} y={66} />
      <rect x={15} y={50} width={50} height={20} rx={6} fill="#ffc857" {...stroke} />
      <rect
        x={20}
        y={32}
        width={40}
        height={20}
        rx={6}
        fill="#7bd389"
        transform="rotate(-3 40 42)"
        {...stroke}
      />
      <rect x={23} y={7} width={34} height={27} rx={8} fill={top} {...stroke} />
      <Eyes x1={33} x2={47} y={18} pose={pose} r={4.8} m={27} />
      {pose === "needs" ? <WaveArm fill={top} x={54} y={26} /> : null}
      {pose === "asleep" ? <Zz x={62} y={4} /> : null}
    </>
  );
}

function Tuft({ pose }: { pose: TotPose }) {
  const fill = pose === "asleep" ? "#a99ac6" : "#b388ff";
  return (
    <>
      <path
        d="M32 22C31 15 28 11 25 8M40 22V5M48 22C49 15 52 11 55 8"
        fill="none"
        stroke={fill}
        strokeWidth={5}
        strokeLinecap="round"
      />
      <Legs fill={fill} />
      <rect x={16} y={20} width={48} height={48} rx={21} fill={fill} {...stroke} />
      <Eyes x1={31} x2={49} y={38} pose={pose} m={50} />
      {pose === "working" ? (
        <>
          <rect x={27} y={50} width={26} height={17} rx={2.5} fill="#15151b" {...stroke} />
          <path
            d="m32 55 3.5 3-3.5 3M38 62h7"
            fill="none"
            stroke="#6dff9a"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {pose === "needs" ? <WaveArm fill={fill} x={59} y={48} /> : null}
      {pose === "asleep" ? <Zz x={64} y={14} /> : null}
    </>
  );
}

function Crt({ pose }: { pose: TotPose }) {
  const awake = pose !== "asleep";
  const glow = awake ? "#6dff9a" : "#39674a";
  const eyeHeight = pose === "needs" ? 11 : pose === "working" ? 5 : 8;
  return (
    <>
      <path
        d="M69 50C80 50 79 66 70 70"
        fill="none"
        stroke={INK}
        strokeWidth={3}
        strokeLinecap="round"
      />
      <rect x={64} y={67} width={8} height={7} rx={1.5} fill="#8f96a3" {...stroke} />
      <path d="M30 60h20l3 8H27z" fill="#b9b09a" {...stroke} />
      <rect x={20} y={67} width={40} height={7} rx={3} fill="#c9c0a8" {...stroke} />
      <rect x={10} y={12} width={60} height={50} rx={8} fill="#d8cfb6" {...stroke} />
      <rect x={17} y={18} width={46} height={35} rx={5} fill="#101b15" {...stroke} />
      <circle cx={63} cy={57.5} r={2.2} fill={awake ? "#6dff9a" : "#7f7a68"} />
      {awake ? (
        <>
          <rect x={26} y={34 - eyeHeight / 2} width={8} height={eyeHeight} fill={glow} />
          <rect x={46} y={34 - eyeHeight / 2} width={8} height={eyeHeight} fill={glow} />
          <path d="M35 44h10" stroke={glow} strokeWidth={2.5} strokeLinecap="round" />
        </>
      ) : (
        <path
          d="M25 35q5 4 10 0M45 35q5 4 10 0"
          fill="none"
          stroke={glow}
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      )}
      {pose === "needs" ? <WaveArm fill="#d8cfb6" x={66} y={38} /> : null}
      {pose === "asleep" ? <Zz x={66} y={6} /> : null}
    </>
  );
}

function Dino({ pose }: { pose: TotPose }) {
  const fill = pose === "asleep" ? "#8fb596" : "#6fcf7c";
  const shell = "#f4ead6";
  return (
    <>
      <path d="M61 56C72 56 76 49 76 43C70 47 66 47 60 46" fill={fill} {...stroke} />
      <path d="M30 13l4-9 5 8 5-8 5 9z" fill="#3f9d58" {...stroke} />
      <rect x={20} y={11} width={40} height={46} rx={18} fill={fill} {...stroke} />
      <Eyes x1={31} x2={49} y={27} pose={pose} m={40} />
      {pose === "needs" ? <WaveArm fill={fill} x={57} y={44} /> : null}
      <path
        d="M13 48L21 41L29 50L40 41L51 50L59 41L67 48C67 65 55 74 40 74C25 74 13 65 13 48Z"
        fill={shell}
        {...stroke}
      />
      <circle cx={26} cy={60} r={2.5} fill="#d9c9a8" />
      <circle cx={52} cy={58} r={3} fill="#d9c9a8" />
      {pose === "asleep" ? <Zz x={64} y={6} /> : null}
    </>
  );
}

export interface TotCharacterDefinition {
  readonly id: string;
  readonly label: string;
  readonly suggestedName: string;
  readonly draw: (pose: TotPose) => ReactNode;
}

/** Swapping art means changing this table: everything else asks for a character and a pose. */
export const TOT_CHARACTERS: ReadonlyArray<TotCharacterDefinition> = [
  {
    id: "brace",
    label: "Curly braces",
    suggestedName: "Brace",
    draw: (pose) => <Brace pose={pose} />,
  },
  {
    id: "nigiri",
    label: "Nigiri",
    suggestedName: "Nigiri",
    draw: (pose) => <Nigiri pose={pose} />,
  },
  {
    id: "blocks",
    label: "Stacked blocks",
    suggestedName: "Stack",
    draw: (pose) => <Blocks pose={pose} />,
  },
  { id: "tuft", label: "Purple tuft", suggestedName: "Tee", draw: (pose) => <Tuft pose={pose} /> },
  { id: "crt", label: "Old monitor", suggestedName: "Ping", draw: (pose) => <Crt pose={pose} /> },
  { id: "dino", label: "Hatchling", suggestedName: "Rex", draw: (pose) => <Dino pose={pose} /> },
];

const FALLBACK_CHARACTER = TOT_CHARACTERS[3]!;

export function totCharacter(id: string): TotCharacterDefinition {
  return TOT_CHARACTERS.find((character) => character.id === id) ?? FALLBACK_CHARACTER;
}

export function TotCharacter(props: {
  readonly character: string;
  readonly pose: TotPose;
  readonly size: number;
  readonly className?: string | undefined;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 80 80"
      width={props.size}
      height={props.size}
      className={cn("shrink-0 overflow-visible text-muted-foreground", props.className)}
    >
      {totCharacter(props.character).draw(props.pose)}
    </svg>
  );
}
