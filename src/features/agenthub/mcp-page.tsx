import { ToolboxPage } from "./page";
import { McpView } from "./mcp-view";
import "./toolbox.css";

export function McpPage() {
  return (
    <ToolboxPage section="mcp">
      <McpView />
    </ToolboxPage>
  );
}
