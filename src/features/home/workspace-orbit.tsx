import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RollingNumber } from "@/components/motion/rolling-number";
import type { HomeRelations } from "./relations";
import { NeuralMedia } from "./neural-media";
import "./workspace-orbit.css";

export type HomeModule = "plans" | "files" | "knowledge" | "fences";
export interface WorkspaceNode {
  id: HomeModule;
  label: string;
  value: number | string;
  detail: string;
  icon: ReactNode;
}

const POSITIONS = [{ x: 23, y: 24 }, { x: 78, y: 25 }, { x: 21, y: 74 }, { x: 80, y: 74 }];
const COLORS = ["#a6cbbd", "#bcb1df", "#cfb47d", "#99becf"];
const FILTERS = ["hue-rotate(118deg)", "hue-rotate(215deg)", "saturate(.8)", "hue-rotate(158deg)"];

/** Composition adapted from neural-creator-dashboard's Home.jsx.
 * Media and attribution: docs/third-party/neural-creator-dashboard/README.md. */
export function WorkspaceOrbit({ nodes, selected, onSelect, onCenter, relations, paused, contentCount }: {
  nodes: WorkspaceNode[];
  selected: HomeModule | null;
  onSelect: (id: HomeModule) => void;
  onCenter: () => void;
  relations: HomeRelations;
  paused: boolean;
  contentCount: number;
}) {
  const { t } = useTranslation();
  const expanded = selected !== null;
  const center = expanded ? { x: 12, y: 49 } : { x: 50, y: 48 };
  const positions = expanded ? nodes.map((_, index) => ({ x: 33, y: 16 + index * 23 })) : POSITIONS;

  return (
    <div className="orbit-field" data-expanded={expanded} data-paused={paused}>
      <div className="workspace-orbit" role="group" aria-label={t("home.workspaceMap")}>
        <div className="neural-atmosphere" aria-hidden="true" />
        <svg className="orbit-lines" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
          {Array.from({ length: 78 }, (_, i) => (
            <circle key={i} cx={12 + i * 173 % 974} cy={14 + i * 137 % 570} r={i % 5 === 0 ? 1.7 : .8} className="orbit-speck" style={{ animationDelay: `${i % 9 * -.6}s` }} />
          ))}
          {nodes.map((node, index) => {
            const p = positions[index];
            const path = `M ${center.x * 10} ${center.y * 6} C ${(center.x + p.x) * 5} ${center.y * 6 + (index % 2 ? 35 : -35)}, ${(center.x + p.x) * 5} ${p.y * 6}, ${p.x * 10} ${p.y * 6}`;
            return <g key={node.id} style={{ color: COLORS[index] }} data-active={selected === node.id}>
              <path d={path} className="orbit-thread-glow" />
              <path d={path} className="orbit-spoke" />
              <path d={path} className="orbit-flow" style={{ animationDelay: `${index * -.9}s` }} />
              {expanded && selected === node.id && Array.from({ length: contentCount }, (_, i) => { const y = 29 + i * 9; return <path key={i} d={`M ${p.x * 10 + 25} ${p.y * 6} C 420 ${p.y * 6}, 430 ${y * 6}, 492 ${y * 6}`} className="orbit-fan" style={{ animationDelay: `${i * .08}s` }} />; })}
            </g>;
          })}
          {!expanded && relations.edges.map((edge) => <path key={edge.kind} d={edge.kind === "plans-items" ? "M 230 144 Q 500 5 780 150" : "M 780 150 Q 965 310 800 444"} className="orbit-relation" />)}
        </svg>
        <button type="button" className="orbit-core" onClick={onCenter} style={{ left: `${center.x}%`, top: `${center.y}%` }} aria-label={expanded ? t("home.returnCenter") : t("home.workspaceTitle")}>
          <span className="orbit-core-halo" aria-hidden="true" />
          <NeuralMedia kind="orb" paused={paused} />
          <span className="orbit-core-copy">{t("home.neuralWorkspace")}</span>
        </button>
        {nodes.map((node, index) => (
          <button type="button" key={node.id} className="orbit-node" style={{ left: `${positions[index].x}%`, top: `${positions[index].y}%`, "--module-color": COLORS[index], "--swim-delay": `${index * -1.7}s`, "--jelly-filter": FILTERS[index] } as CSSProperties} data-active={selected === node.id} aria-pressed={selected === node.id} aria-controls={expanded ? "home-inspector" : undefined} onClick={() => onSelect(node.id)}>
            <span className="orbit-jelly" aria-hidden="true"><NeuralMedia kind="jellyfish" paused={paused} offset={index * 1.37} /></span>
            <span className="orbit-node-caption"><span className="orbit-node-heading"><span className="orbit-node-icon" aria-hidden="true">{node.icon}</span><span className="orbit-node-label">{node.label}</span><RollingNumber value={node.value} className="orbit-node-count" /></span><span className="orbit-node-detail">{node.detail}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}
