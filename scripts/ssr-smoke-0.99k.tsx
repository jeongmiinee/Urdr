import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoProject, getStateAtYear } from "../src/model/world.ts";
import { HomeScreen } from "../src/components/HomeScreen.tsx";
import { HeraldryDisplay } from "../src/components/HeraldryStudio.tsx";
import { FamilyProfilePanel } from "../src/components/GenealogyPanels.tsx";

const project = createDemoProject();
const map = project.maps[0];
const faction = map.factions.find((item) => item.displayFlag || item.displayCoatOfArms);
if (!faction) throw new Error("demo heraldry faction missing");
const polygons = map.territories.flatMap((territory) => {
  const state = getStateAtYear(territory.states, map.timeline.currentYear);
  return state?.ownerFactionId === faction.id ? [state.polygon] : [];
});
const heraldry = renderToStaticMarkup(<HeraldryDisplay project={project} territoryPolygons={polygons} territoryColor={faction.color} showFlag={faction.displayFlag} showCoat={faction.displayCoatOfArms} flagAssetId={faction.flagAssetId} coatAssetId={faction.coatOfArmsAssetId} />);
if (!heraldry.includes("heraldry-document-display")) throw new Error("heraldry display SSR missing");
const home = renderToStaticMarkup(<HomeScreen recents={[]} onNew={()=>{}} onDemo={()=>{}} onImport={()=>{}} onOpenRecent={()=>{}} onDeleteRecent={()=>{}} onExit={()=>{}} canExit={false} theme="light" onThemeChange={()=>{}} />);
if (!home.includes("v0.99k")) throw new Error("home version SSR missing");
const family = project.wikiArticles.find((article) => article.familyProfile);
if (!family) throw new Error("demo family missing");
const familyHtml = renderToStaticMarkup(<FamilyProfilePanel project={project} article={family} editMode={false} onChange={()=>{}} onProjectChange={()=>{}} onOpenArticle={()=>{}} />);
if (!familyHtml.includes("가계도") || !familyHtml.includes("heraldry-document-display")) throw new Error("family SSR missing");
console.log(JSON.stringify({ homeBytes: home.length, heraldryBytes: heraldry.length, familyBytes: familyHtml.length }));
