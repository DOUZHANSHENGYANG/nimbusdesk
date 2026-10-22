import { ToolboxPage } from "./page";
import { HarnessView } from "./harness-view";
import "./toolbox.css";

export function HarnessPage() {
  return (
    <ToolboxPage section="harness">
      <HarnessView />
    </ToolboxPage>
  );
}
