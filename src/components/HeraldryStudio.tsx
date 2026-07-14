import React, { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createId, type HeraldicAsset, type HeraldicAssetKind, type HeraldicPattern, type HeraldicSymbol, type Point, type WorldProject } from "../model/world";
import { sortSelectionOptions } from "../model/selectionSort";

type AssetPatch = Partial<Omit<HeraldicAsset, "id" | "kind" | "createdAt" | "updatedAt">>;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const flagShapes = [{ id: "square", label: "정사각형" }, { id: "rectangle", label: "일반 깃발" }, { id: "pennant", label: "끝이 뾰족" }, { id: "triangle", label: "삼각형" }];
const coatShapes = [{ id: "shield", label: "방패" }, { id: "circle", label: "원" }, { id: "square", label: "정사각형" }, { id: "triangle", label: "정삼각형" }, { id: "diamond", label: "마름모꼴" }];
const patterns = [{ id: "solid", label: "민무늬" }, { id: "stripes", label: "줄무늬" }, { id: "grid", label: "격자무늬" }, { id: "checkered", label: "체크무늬" }];
const symbols = [
  { id: "none", label: "없음" }, { id: "spade", label: "스페이드" }, { id: "diamond", label: "다이아몬드" }, { id: "palm", label: "손바닥" },
  { id: "castle", label: "성" }, { id: "spear", label: "창" }, { id: "sword", label: "칼" }, { id: "circle", label: "동그라미" },
  { id: "crown", label: "왕관" }, { id: "cross", label: "십자가" }, { id: "star", label: "별" }, { id: "crescent_star", label: "초승달과 별" },
  { id: "iron_cross", label: "철십자" }, { id: "heart", label: "하트" }, { id: "fortress_wall", label: "성벽" },
];

export function createDefaultHeraldicAsset(kind: HeraldicAssetKind): HeraldicAsset {
  const now = new Date().toISOString();
  return {
    id: createId(kind === "flag" ? "flag-asset" : "coat-asset"), kind,
    name: kind === "flag" ? "새 깃발" : "새 문장", source: "generated",
    shape: kind === "flag" ? "rectangle" : "shield", pattern: "solid", symbol: "none",
    backgroundColor: "#234f8a", patternColor: "#e8d5a1", symbolColor: "#f7f4e8",
    patternScale: 1, symbolScale: 1, symbolOffsetX: 0, symbolOffsetY: 0,
    createdAt: now, updatedAt: now,
  };
}

function normalizedAsset(asset: HeraldicAsset): HeraldicAsset {
  return { ...asset, patternScale: asset.patternScale ?? 1, symbolScale: asset.symbolScale ?? 1, symbolOffsetX: asset.symbolOffsetX ?? 0, symbolOffsetY: asset.symbolOffsetY ?? 0 };
}

function shapePath(asset: HeraldicAsset): string | undefined {
  if (asset.kind === "flag") {
    if (asset.shape === "pennant") return "M8 10 H86 L62 50 L86 90 H8 Z";
    if (asset.shape === "triangle") return "M10 10 L90 50 L10 90 Z";
    if (asset.shape === "square") return "M12 10 H88 V90 H12 Z";
    return "M6 18 H94 V82 H6 Z";
  }
  if (asset.shape === "shield") return "M18 12 H82 V48 C82 72 65 86 50 94 C35 86 18 72 18 48 Z";
  if (asset.shape === "circle") return undefined;
  if (asset.shape === "triangle") return "M50 8 L92 88 H8 Z";
  if (asset.shape === "diamond") return "M50 7 L93 50 L50 93 L7 50 Z";
  return "M12 12 H88 V88 H12 Z";
}

function SymbolShape({ symbol, color }: { symbol: HeraldicSymbol; color: string }) {
  if (symbol === "none") return null;
  if (symbol === "diamond") return <path d="M50 26 L68 50 L50 74 L32 50 Z" fill={color} />;
  if (symbol === "spade") return <path d="M50 24 C43 35 30 38 30 51 C30 61 38 67 47 61 L43 75 H57 L53 61 C62 67 70 61 70 51 C70 38 57 35 50 24 Z" fill={color} />;
  if (symbol === "palm") return <path d="M38 70 C32 62 31 52 34 43 L38 48 L39 31 L45 43 L47 25 L52 42 L57 29 L58 48 L65 38 C68 53 65 67 57 76 H42 Z" fill={color} />;
  if (symbol === "castle") return <path d="M27 72 V40 H34 V31 H43 V40 H57 V31 H66 V40 H73 V72 Z M37 72 V57 H47 V72 Z M55 72 V57 H65 V72 Z" fill={color} fillRule="evenodd" />;
  if (symbol === "fortress_wall") return <path d="M20 70 V46 H28 V37 H38 V46 H46 V37 H56 V46 H64 V37 H74 V46 H82 V70 Z M30 70 V58 H40 V70 Z M60 70 V58 H70 V70 Z" fill={color} fillRule="evenodd" />;
  if (symbol === "spear") return <path d="M47 76 H53 V38 L61 47 L50 20 L39 47 L47 38 Z" fill={color} />;
  if (symbol === "sword") return <path d="M47 73 H53 V42 L62 33 L58 29 L50 37 L42 29 L38 33 L47 42 Z M38 48 H62 V54 H38 Z" fill={color} />;
  if (symbol === "circle") return <circle cx="50" cy="50" r="22" fill={color} />;
  if (symbol === "crown") return <path d="M25 68 L20 34 L38 48 L50 25 L62 48 L80 34 L75 68 Z M27 72 H73 V78 H27 Z" fill={color} />;
  if (symbol === "cross") return <path d="M43 22 H57 V42 H77 V56 H57 V78 H43 V56 H23 V42 H43 Z" fill={color} />;
  if (symbol === "iron_cross") return <path d="M38 22 H62 L59 39 L78 36 V64 L59 61 L62 78 H38 L41 61 L22 64 V36 L41 39 Z" fill={color} />;
  if (symbol === "star") return <path d="M50 20 L58 41 L80 42 L63 56 L69 78 L50 66 L31 78 L37 56 L20 42 L42 41 Z" fill={color} />;
  if (symbol === "crescent_star") return <g fill={color}><path d="M49 25 A27 27 0 1 0 49 75 A21 21 0 1 1 49 25 Z" /><path d="M68 35 L72 45 L83 45 L74 52 L77 63 L68 57 L59 63 L62 52 L53 45 L64 45 Z" /></g>;
  if (symbol === "heart") return <path d="M50 77 C42 67 24 58 24 42 C24 29 39 24 50 37 C61 24 76 29 76 42 C76 58 58 67 50 77 Z" fill={color} />;
  return null;
}

export function HeraldicPreview({ asset, className = "", interactive = false, onSymbolOffsetChange }: { asset?: HeraldicAsset; className?: string; interactive?: boolean; onSymbolOffsetChange?: (x: number, y: number) => void }) {
  if (!asset) return <div className={`heraldry-placeholder ${className}`}>미설정</div>;
  const value = normalizedAsset(asset);
  if (value.source === "upload" && value.imageDataUrl) return <img className={`heraldry-preview-image ${className}`} src={value.imageDataUrl} alt={value.name} />;
  const clipId = `clip-${value.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const path = shapePath(value);
  const patternScale = clamp(value.patternScale ?? 1, 0.45, 2.5);
  const stripeGap = 34 * patternScale;
  const stripeWidth = 14 * patternScale;
  const gridGap = 24 * patternScale;
  const gridWidth = 7 * patternScale;
  const checkerSize = 18 * patternScale;
  const checkPatternId = `${clipId}-checkered`;
  const transform = `translate(${(value.symbolOffsetX ?? 0) * 28} ${(value.symbolOffsetY ?? 0) * 28}) translate(50 50) scale(${value.symbolScale ?? 1}) translate(-50 -50)`;
  const pointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive || value.symbol === "none" || !onSymbolOffsetChange) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100;
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
    onSymbolOffsetChange(clamp((x - 50) / 28, -1, 1), clamp((y - 50) / 28, -1, 1));
  };
  return <svg className={`heraldry-preview-svg ${interactive ? "interactive" : ""} ${className}`} viewBox="0 0 100 100" role="img" aria-label={value.name}
    onPointerDown={(event) => { if (interactive) { event.currentTarget.setPointerCapture(event.pointerId); pointer(event); } }}
    onPointerMove={(event) => { if (interactive && event.currentTarget.hasPointerCapture(event.pointerId)) pointer(event); }}>
    <defs><clipPath id={clipId}>{value.kind === "coatOfArms" && value.shape === "circle" ? <circle cx="50" cy="50" r="40" /> : <path d={path} />}</clipPath><pattern id={checkPatternId} width={checkerSize * 2} height={checkerSize * 2} patternUnits="userSpaceOnUse"><rect width={checkerSize} height={checkerSize} fill={value.patternColor}/><rect x={checkerSize} y={checkerSize} width={checkerSize} height={checkerSize} fill={value.patternColor}/></pattern></defs>
    <g clipPath={`url(#${clipId})`}>
      <rect width="100" height="100" fill={value.backgroundColor} />
      {value.pattern === "stripes" && Array.from({ length: 9 }, (_, n) => <rect key={n} x={n * stripeGap - stripeGap * 2.5} y="-25" width={stripeWidth} height="150" transform="rotate(25 50 50)" fill={value.patternColor} />)}
      {value.pattern === "grid" && <>{Array.from({ length: 7 }, (_, n) => 8 + n * gridGap).map((n) => <g key={n}><rect x={n} width={gridWidth} height="100" fill={value.patternColor} /><rect y={n} width="100" height={gridWidth} fill={value.patternColor} /></g>)}</>}
      {value.pattern === "checkered" && <rect width="100" height="100" fill={`url(#${checkPatternId})`} />}
      <g transform={transform}><SymbolShape symbol={value.symbol} color={value.symbolColor} /></g>
    </g>
    {value.kind === "coatOfArms" && value.shape === "circle" ? <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="3" /> : <path d={path} fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />}
  </svg>;
}

function TerritoryPreview({ polygons, color }: { polygons: Point[][]; color: string }) {
  const bounds = useMemo(() => { const all = polygons.flat(); if (!all.length) return null; const xs = all.map(p=>p.x), ys=all.map(p=>p.y); return { minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys) }; }, [polygons]);
  if (!bounds) return null;
  const width=Math.max(1,bounds.maxX-bounds.minX), height=Math.max(1,bounds.maxY-bounds.minY), scale=Math.min(260/width,130/height), ox=(280-width*scale)/2, oy=(150-height*scale)/2;
  const points=(polygon:Point[])=>polygon.map(point=>`${ox+(point.x-bounds.minX)*scale},${oy+(point.y-bounds.minY)*scale}`).join(" ");
  return <div className="territory-document-preview"><span>현재 영토</span><svg viewBox="0 0 280 150" aria-label="현재 영토 모습">{polygons.map((polygon,index)=><polygon key={index} points={points(polygon)} fill={color} stroke="color-mix(in srgb, currentColor 55%, transparent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}</svg></div>;
}

export function HeraldryDisplay({ project, flagAssetId, coatAssetId, showFlag, showCoat, territoryPolygons = [], territoryColor = "#5f8fb3" }: { project: WorldProject; flagAssetId?: string; coatAssetId?: string; showFlag?: boolean; showCoat?: boolean; territoryPolygons?: Point[][]; territoryColor?: string }) {
  const flag=project.heraldicAssets.find(a=>a.id===flagAssetId&&a.kind==="flag"), coat=project.heraldicAssets.find(a=>a.id===coatAssetId&&a.kind==="coatOfArms");
  if (!territoryPolygons.length&&!showFlag&&!showCoat) return null;
  return <section className="heraldry-document-display">{territoryPolygons.length>0&&<TerritoryPreview polygons={territoryPolygons} color={territoryColor}/>} {(showFlag||showCoat)&&<div className="heraldry-pair">{showFlag&&<div><span>깃발</span><HeraldicPreview asset={flag}/></div>}{showCoat&&<div><span>문장</span><HeraldicPreview asset={coat}/></div>}</div>}</section>;
}

export function HeraldryStudioModal({ project, kind, onChange, onClose, onSelect, onSave, startNew = false, initialAssetId }: { project: WorldProject; kind: HeraldicAssetKind; onChange:(project:WorldProject)=>void; onClose:()=>void; onSelect?:(assetId:string)=>void; onSave?:(project:WorldProject,assetId:string)=>void; startNew?:boolean; initialAssetId?:string }) {
  const existing=project.heraldicAssets.filter(a=>a.kind===kind).map(normalizedAsset);
  const initial=(!startNew&&initialAssetId?existing.find(a=>a.id===initialAssetId):undefined) ?? (!startNew?existing[0]:undefined) ?? createDefaultHeraldicAsset(kind);
  const [draft,setDraft]=useState<HeraldicAsset>({...initial});
  const [activeTab,setActiveTab]=useState<"shape"|"pattern"|"symbol">("shape");
  const fileRef=useRef<HTMLInputElement>(null); const shapes=kind==="flag"?flagShapes:coatShapes;
  const patch=(value:AssetPatch)=>setDraft(current=>({...current,...value,updatedAt:new Date().toISOString()}));
  const save=()=>{const exists=project.heraldicAssets.some(a=>a.id===draft.id);const nextProject={...project,heraldicAssets:exists?project.heraldicAssets.map(a=>a.id===draft.id?draft:a):[...project.heraldicAssets,draft]};if(onSave)onSave(nextProject,draft.id);else{onChange(nextProject);onSelect?.(draft.id);}};
  const upload=(file?:File)=>{if(!file)return;const reader=new FileReader();reader.onload=()=>patch({source:"upload",imageDataUrl:String(reader.result??""),name:file.name.replace(/\.[^.]+$/," ").trim()||draft.name});reader.readAsDataURL(file);};
  const previewFor=(value:AssetPatch,index:number):HeraldicAsset=>({...draft,...value,id:`preview-${activeTab}-${index}`,name:"선택 예시",source:"generated"});
  const optionGrid=(items:ReadonlyArray<{id:string;label:string}>, selected:string, apply:(id:string)=>void, field:"shape"|"pattern"|"symbol")=><div className="heraldry-option-grid">{items.map((item,index)=><button type="button" key={item.id} className={selected===item.id?"active":""} onClick={()=>apply(item.id)}><HeraldicPreview asset={previewFor({[field]:item.id} as AssetPatch,index)}/><span>{item.label}</span></button>)}</div>;
  return createPortal(<div className="modal-backdrop heraldry-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="heraldry-studio" role="dialog" aria-modal="true"><header><div><p className="eyebrow">HERALDRY STUDIO</p><h2>{kind==="flag"?"깃발 생성/편집기":"문장 생성/편집기"}</h2></div><button type="button" onClick={onClose}>×</button></header><div className="heraldry-studio-grid">
    <aside><button type="button" className="primary-button full" onClick={()=>setDraft(createDefaultHeraldicAsset(kind))}>＋ 새 자산</button>{sortSelectionOptions(existing.map(asset=>({id:asset.id,label:asset.name,asset}))).map(({asset})=><button type="button" className={asset.id===draft.id?"active":""} key={asset.id} onClick={()=>setDraft({...asset})}><HeraldicPreview asset={asset}/><span title={asset.name}>{asset.name}</span></button>)}</aside>
    <main><div className="heraldry-live-preview"><HeraldicPreview asset={draft} interactive={draft.source==="generated"} onSymbolOffsetChange={(x,y)=>patch({symbolOffsetX:x,symbolOffsetY:y})}/><small>{draft.source==="generated"&&draft.symbol!=="none"?"문양을 마우스로 끌어 위치를 조정하세요.":"실시간 미리보기"}</small></div>
      <div className="form-grid two heraldry-name-format-row"><label>이름<input value={draft.name} onChange={e=>patch({name:e.target.value})}/></label><label>형식<select value={draft.source} onChange={e=>patch({source:e.target.value as HeraldicAsset["source"]})}><option value="generated">생성기</option><option value="upload">사진 업로드</option></select></label></div>
      {draft.source==="upload"?<div className="heraldry-upload"><input ref={fileRef} hidden type="file" accept="image/*" onChange={e=>upload(e.target.files?.[0])}/><button type="button" onClick={()=>fileRef.current?.click()}>사진 선택</button><small>PNG, JPG, SVG 등 이미지 파일을 프로젝트에 저장합니다.</small></div>:<div className="heraldry-tab-workspace">
        <nav className="heraldry-browser-tabs" aria-label="깃발과 문장 구성"><button type="button" className={activeTab==="shape"?"active":""} onClick={()=>setActiveTab("shape")}>모양</button><button type="button" className={activeTab==="pattern"?"active":""} onClick={()=>setActiveTab("pattern")}>무늬</button><button type="button" className={activeTab==="symbol"?"active":""} onClick={()=>setActiveTab("symbol")}>문양</button></nav>
        {activeTab==="shape"&&<section className="heraldry-tab-panel"><label className="heraldry-tab-color">모양 색상<input type="color" value={draft.backgroundColor} onChange={e=>patch({backgroundColor:e.target.value})}/></label>{optionGrid(shapes,draft.shape,id=>patch({shape:id as HeraldicAsset["shape"]}),"shape")}</section>}
        {activeTab==="pattern"&&<section className="heraldry-tab-panel"><label className="heraldry-tab-color">무늬 색상<input type="color" value={draft.patternColor} onChange={e=>patch({patternColor:e.target.value})}/></label>{optionGrid(patterns,draft.pattern,id=>patch({pattern:id as HeraldicPattern}),"pattern")}<label className={draft.pattern==="solid"?"disabled heraldry-tab-slider":"heraldry-tab-slider"}>무늬 크기 <strong>{Math.round((draft.patternScale??1)*100)}%</strong><input type="range" min="45" max="250" value={Math.round((draft.patternScale??1)*100)} disabled={draft.pattern==="solid"} onChange={e=>patch({patternScale:Number(e.target.value)/100})}/></label></section>}
        {activeTab==="symbol"&&<section className="heraldry-tab-panel"><label className="heraldry-tab-color">문양 색상<input type="color" value={draft.symbolColor} onChange={e=>patch({symbolColor:e.target.value})}/></label>{optionGrid(symbols,draft.symbol,id=>patch({symbol:id as HeraldicSymbol}),"symbol")}<label className={draft.symbol==="none"?"disabled heraldry-tab-slider":"heraldry-tab-slider"}>문양 크기 <strong>{Math.round((draft.symbolScale??1)*100)}%</strong><input type="range" min="35" max="220" value={Math.round((draft.symbolScale??1)*100)} disabled={draft.symbol==="none"} onChange={e=>patch({symbolScale:Number(e.target.value)/100})}/></label><div className="heraldry-position-row"><button type="button" disabled={draft.symbol==="none"} onClick={()=>patch({symbolOffsetX:0,symbolOffsetY:0})}>문양 가운데 정렬</button><span>X {Math.round((draft.symbolOffsetX??0)*100)} · Y {Math.round((draft.symbolOffsetY??0)*100)}</span></div></section>}
      </div>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>취소</button><button type="button" className="primary-button" onClick={save}>저장{onSelect?" 및 사용":""}</button></footer>
    </main></div></section></div>,document.body);
}

export function HeraldryEditorFields({ project, displayFlag, displayCoat, flagAssetId, coatAssetId, onProjectChange, onChange, onCommit }: { project:WorldProject;displayFlag?:boolean;displayCoat?:boolean;flagAssetId?:string;coatAssetId?:string;onProjectChange:(project:WorldProject)=>void;onChange:(patch:{displayFlag?:boolean;displayCoatOfArms?:boolean;flagAssetId?:string;coatOfArmsAssetId?:string})=>void;onCommit?:(project:WorldProject,patch:{flagAssetId?:string;coatOfArmsAssetId?:string})=>void }) {
  const [studio,setStudio]=useState<{kind:HeraldicAssetKind;startNew:boolean}|null>(null);
  const flag=project.heraldicAssets.find(a=>a.id===flagAssetId&&a.kind==="flag"), coat=project.heraldicAssets.find(a=>a.id===coatAssetId&&a.kind==="coatOfArms");
  const block=(kind:HeraldicAssetKind, enabled:boolean, asset:HeraldicAsset|undefined)=>enabled&&<div className="heraldry-inline-editor"><HeraldicPreview asset={asset}/><div className="heraldry-inline-actions"><button type="button" onClick={()=>setStudio({kind,startNew:false})}>불러오기</button><button type="button" onClick={()=>setStudio({kind,startNew:true})}>새로 만들기</button></div></div>;
  return <section className="heraldry-editor-fields"><h4>깃발과 문장</h4><div className="heraldry-toggle-grid"><div><label><input type="checkbox" checked={Boolean(displayFlag)} onChange={e=>onChange({displayFlag:e.target.checked})}/> 깃발 사용</label>{block("flag",Boolean(displayFlag),flag)}</div><div><label><input type="checkbox" checked={Boolean(displayCoat)} onChange={e=>onChange({displayCoatOfArms:e.target.checked})}/> 문장 사용</label>{block("coatOfArms",Boolean(displayCoat),coat)}</div></div>{studio&&<HeraldryStudioModal project={project} kind={studio.kind} startNew={studio.startNew} initialAssetId={studio.kind==="flag"?flagAssetId:coatAssetId} onChange={onProjectChange} onSave={(next,id)=>{const patch=studio.kind==="flag"?{flagAssetId:id}:{coatOfArmsAssetId:id};if(onCommit)onCommit(next,patch);else{onProjectChange(next);onChange(patch);}setStudio(null);}} onClose={()=>setStudio(null)}/>}</section>;
}
