import type { MapData, WorldProject } from "../model/world";
import { ProjectSettingsWindow } from "./ProjectSettingsWindow";

type Props = {
  project: WorldProject;
  map: MapData | null;
  onChange: (project: WorldProject) => void;
  onMapChange: (map: MapData) => void;
};

export function ProjectHomeWindow({ project, map, onChange, onMapChange }: Props) {
  return (
    <section className="project-home-window unified-scroll-area">
      <div className="project-home-hero">
        <h1>{project.title}</h1>
        <p>{project.description || "지도·세계관·환경을 분리해 한 프로젝트에서 관리하세요."}</p>
      </div>
      <ProjectSettingsWindow project={project} map={map} onChange={onChange} onMapChange={onMapChange} />
    </section>
  );
}
