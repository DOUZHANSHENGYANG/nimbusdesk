import { jsonSchema, tool } from "ai";
import { tbPromptList, tbSkillCreate, tbSkillList } from "@/features/agenthub/api";
import { searchQuery } from "@/features/search/api";
import type { SearchHit } from "@/features/search/types";
import { inTauri } from "@/lib/tauri";

/**
 * 面板能调的能力 = **现有的 Rust 命令的一个安全子集**，不为工具新增任何命令。
 * 工具实现只做两件事：校验参数 → `invoke()` 一个已存在的命令。
 *
 * v1 只有三个只读工具；唯一的写类工具 `save_skill` 走 AI SDK 的审批机制
 * （`model.ts` 里的 `toolApproval`），批准前不会落盘。
 */
const trim = (text: string, limit = 160) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

const location = (hit: SearchHit) => hit.subtitle || hit.path || hit.url || "";

/** 浏览器 dev 里没有 `invoke`：给模型一句能读懂的话，而不是抛一个 undefined。 */
function requireDesktop(): void {
  if (!inTauri) throw new Error("AI_NO_DESKTOP");
}

export const agentTools = {
  search_workspace: tool({
    description:
      "在工作台里按关键词检索：知识库笔记、计划、项目、资讯与应用。返回最相关的若干条，含标题、位置与摘要片段。",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      required: ["query"],
      properties: { query: { type: "string", description: "关键词或短语，越具体越好" } },
    }),
    execute: async ({ query }) => {
      requireDesktop();
      const reply = await searchQuery(query, "all", true);
      return {
        total: reply.total,
        results: reply.results.slice(0, 8).map((hit) => ({
          kind: hit.kind,
          title: hit.title,
          location: location(hit),
          snippet: trim(hit.snippet),
        })),
        warnings: reply.warnings,
      };
    },
  }),

  list_skills: tool({
    description: "列出工具箱里已有的技能（名称、说明、标签）。",
    inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
    execute: async () => {
      requireDesktop();
      const skills = await tbSkillList();
      return {
        total: skills.length,
        skills: skills
          .slice(0, 50)
          .map((skill) => ({ name: skill.name, description: trim(skill.description, 120), tags: skill.tags })),
      };
    },
  }),

  list_prompts: tool({
    description: "列出工具箱里已有的提示词（标题、说明、标签）。正文不在列表里。",
    inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
    execute: async () => {
      requireDesktop();
      const prompts = await tbPromptList();
      return {
        total: prompts.length,
        prompts: prompts
          .slice(0, 50)
          .map((prompt) => ({ title: prompt.title, description: trim(prompt.description, 120), tags: prompt.tags })),
      };
    },
  }),

  save_skill: tool({
    description:
      "在工具箱里新建一个技能（落盘 SKILL.md）。写类操作，需要用户批准后才执行。",
    inputSchema: jsonSchema<{ name: string; description: string }>({
      type: "object",
      required: ["name", "description"],
      properties: {
        name: { type: "string", description: "技能名，会转成英文小写目录名" },
        description: { type: "string", description: "一句话说明：解决什么问题、什么时候用" },
      },
    }),
    execute: async ({ name, description }) => {
      requireDesktop();
      const created = await tbSkillCreate(name, description);
      return { dirName: created.dirName, name: created.name };
    },
  }),
};

export type AgentTools = typeof agentTools;
