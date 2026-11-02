/** 侧栏「项目 → GitHub 仓库」的独立页面：页头与内容都由面板自己排，这里只挂路由。 */
import { useNavigate } from "react-router-dom";
import { GithubPanel } from "./github-panel";

export function GithubPage() {
  const navigate = useNavigate();
  return <GithubPanel onOpenProject={(projectId) => navigate(`/projects?project=${encodeURIComponent(projectId)}`)} />;
}
