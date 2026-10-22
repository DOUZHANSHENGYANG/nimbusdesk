import type { AiProviderTestResult } from "@/ahub/lib/types";

/**
 * 把连通性测试结果翻成一句本地化文案。
 * `message` 是后端给的技术细节（含厂商名与 HTTP 状态），只在网络/解析失败时原样附上；
 * 成功与超时、HTTP 状态由前端按 reason / status 本地化。
 */
export function testResultText(
  r: AiProviderTestResult,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (r.ok) return t("aiProvider.testOk", { ms: r.elapsedMs, model: r.model || "—" });
  switch (r.reason) {
    case "timeout":
      return t("aiProvider.testTimeout", { sec: 15 });
    case "network":
      return t("aiProvider.testNetwork", { msg: r.message });
    case "parse":
      return t("aiProvider.testParse", { msg: r.message });
    default:
      return r.status > 0 ? t("aiProvider.testHttp", { status: r.status }) : r.message;
  }
}
