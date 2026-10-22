import { ToolboxPage } from "./page";
import { SkillsView } from "./skills-view";
import "./toolbox.css";

export function SkillsPage() {
  return (
    <ToolboxPage section="skills">
      <SkillsView />
    </ToolboxPage>
  );
}
