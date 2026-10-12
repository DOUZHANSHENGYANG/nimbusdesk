import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

export { gsap, useGSAP };

/** 统一缓动（与 token --pr-ease-* 对应） */
export const EASE = {
  out: "power3.out",
  inOut: "power2.inOut",
  soft: "sine.out",
  expo: "expo.out",
  back: "back.out(1.4)",
} as const;

/** 统一时长（秒） */
export const DUR = {
  fast: 0.16,
  base: 0.28,
  slow: 0.46,
} as const;
