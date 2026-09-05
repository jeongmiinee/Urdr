use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::model::{Point, RiverSegment};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiverNodeKind {
    Source,
    Confluence,
    Ordinary,
    LakeInlet,
    LakeOutlet,
    OceanMouth,
    BorderContinuation,
    ClosedTerminal,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiverNode {
    pub id: String,
    pub point: Point,
    pub kind: RiverNodeKind,
    pub incoming_reach_ids: Vec<String>,
    pub outgoing_reach_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiverReach {
    pub id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub centerline: Vec<Point>,
    pub contributing_area_km2: f64,
    pub discharge_start_m3s: f64,
    pub discharge_end_m3s: f64,
    pub strahler_order: u8,
    pub shreve_magnitude: u32,
    pub width_start_m: f64,
    pub width_end_m: f64,
    pub depth_m: f64,
    pub velocity_ms: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiverGraph {
    pub revision: u16,
    pub source_map_id: String,
    pub legacy_derived: bool,
    pub nodes: Vec<RiverNode>,
    pub reaches: Vec<RiverReach>,
}

#[derive(Clone)]
struct Edge {
    from: usize,
    to: usize,
    segment: RiverSegment,
}

impl RiverGraph {
    pub fn from_segments(
        source_map_id: &str,
        segments: &[RiverSegment],
        legacy_derived: bool,
    ) -> Self {
        Self::from_segments_with_revision(source_map_id, segments, legacy_derived, 1)
    }

    pub fn from_segments_with_revision(
        source_map_id: &str,
        segments: &[RiverSegment],
        legacy_derived: bool,
        revision: u16,
    ) -> Self {
        let mut keys = BTreeSet::new();
        for segment in segments {
            keys.insert(point_key(segment.start));
            keys.insert(point_key(segment.end));
        }
        let key_to_index = keys
            .into_iter()
            .enumerate()
            .map(|(index, key)| (key, index))
            .collect::<BTreeMap<_, _>>();
        let mut points = vec![Point { x: 0.0, y: 0.0 }; key_to_index.len()];
        for segment in segments {
            points[key_to_index[&point_key(segment.start)]] = segment.start;
            points[key_to_index[&point_key(segment.end)]] = segment.end;
        }
        let mut edges = segments
            .iter()
            .cloned()
            .map(|segment| Edge {
                from: key_to_index[&point_key(segment.start)],
                to: key_to_index[&point_key(segment.end)],
                segment,
            })
            .filter(|edge| edge.from != edge.to)
            .collect::<Vec<_>>();
        edges.sort_by_key(|edge| (edge.from, edge.to));
        edges.dedup_by(|left, right| {
            left.from == right.from
                && left.to == right.to
                && point_key(left.segment.start) == point_key(right.segment.start)
                && point_key(left.segment.end) == point_key(right.segment.end)
        });

        let mut incoming = vec![Vec::new(); points.len()];
        let mut outgoing = vec![Vec::new(); points.len()];
        for (index, edge) in edges.iter().enumerate() {
            outgoing[edge.from].push(index);
            incoming[edge.to].push(index);
        }
        let mut used = vec![false; edges.len()];
        let mut chains = Vec::new();
        for edge_index in 0..edges.len() {
            let edge = &edges[edge_index];
            if incoming[edge.from].len() == 1 && outgoing[edge.from].len() == 1 {
                continue;
            }
            chains.push(walk_chain(
                edge_index, &edges, &incoming, &outgoing, &mut used,
            ));
        }
        for edge_index in 0..edges.len() {
            if !used[edge_index] {
                chains.push(walk_chain(
                    edge_index, &edges, &incoming, &outgoing, &mut used,
                ));
            }
        }

        let source_hash = stable_hash(source_map_id.as_bytes());
        let mut reaches = chains
            .into_iter()
            .enumerate()
            .filter_map(|(reach_index, chain)| {
                let first_index = *chain.first()?;
                let last_index = *chain.last()?;
                let first = &edges[first_index];
                let last = &edges[last_index];
                let mut centerline = Vec::with_capacity(chain.len() + 1);
                centerline.push(first.segment.start);
                for edge_index in &chain {
                    centerline.push(edges[*edge_index].segment.end);
                }
                let discharge_start = f64::from(first.segment.discharge.max(0.0));
                let discharge_end = f64::from(last.segment.discharge.max(first.segment.discharge));
                let width_start = f64::from(first.segment.width.max(0.0)) * 1_000.0;
                let width_end = f64::from(last.segment.width.max(first.segment.width)) * 1_000.0;
                let order = chain
                    .iter()
                    .map(|index| edges[*index].segment.stream_order)
                    .max()
                    .unwrap_or(1)
                    .max(1);
                Some((
                    first.from,
                    last.to,
                    RiverReach {
                        id: format!("reach-{source_hash:016x}-{reach_index:06}"),
                        from_node_id: String::new(),
                        to_node_id: String::new(),
                        centerline,
                        contributing_area_km2: discharge_end.powf(0.82) * 2.4,
                        discharge_start_m3s: discharge_start,
                        discharge_end_m3s: discharge_end,
                        strahler_order: order,
                        shreve_magnitude: 1_u32 << u32::from(order.saturating_sub(1).min(30)),
                        width_start_m: width_start,
                        width_end_m: width_end,
                        depth_m: (0.28 * discharge_end.max(0.01).powf(0.31)).clamp(0.15, 80.0),
                        velocity_ms: (0.34 * discharge_end.max(0.01).powf(0.18)).clamp(0.08, 8.0),
                    },
                ))
            })
            .collect::<Vec<_>>();

        let referenced_nodes = reaches
            .iter()
            .flat_map(|(from, to, _)| [*from, *to])
            .collect::<BTreeSet<_>>();
        let mut node_ids = BTreeMap::new();
        for node_index in referenced_nodes {
            node_ids.insert(
                node_index,
                format!("river-node-{source_hash:016x}-{node_index:06}"),
            );
        }
        for (from, to, reach) in &mut reaches {
            reach.from_node_id = node_ids[from].clone();
            reach.to_node_id = node_ids[to].clone();
        }
        let reaches = reaches
            .into_iter()
            .map(|(_, _, reach)| reach)
            .collect::<Vec<_>>();
        let nodes = node_ids
            .into_iter()
            .map(|(index, id)| {
                let incoming_reach_ids = reaches
                    .iter()
                    .filter(|reach| reach.to_node_id == id)
                    .map(|reach| reach.id.clone())
                    .collect::<Vec<_>>();
                let outgoing_reach_ids = reaches
                    .iter()
                    .filter(|reach| reach.from_node_id == id)
                    .map(|reach| reach.id.clone())
                    .collect::<Vec<_>>();
                let kind = match (incoming_reach_ids.len(), outgoing_reach_ids.len()) {
                    (0, _) => RiverNodeKind::Source,
                    (2.., _) => RiverNodeKind::Confluence,
                    (_, 0) => RiverNodeKind::ClosedTerminal,
                    _ => RiverNodeKind::Ordinary,
                };
                RiverNode {
                    id,
                    point: points[index],
                    kind,
                    incoming_reach_ids,
                    outgoing_reach_ids,
                }
            })
            .collect();
        Self {
            revision,
            source_map_id: source_map_id.to_owned(),
            legacy_derived,
            nodes,
            reaches,
        }
    }

    pub fn to_segments(&self) -> Vec<RiverSegment> {
        let mut segments = Vec::new();
        for reach in &self.reaches {
            let count = reach.centerline.len().saturating_sub(1).max(1);
            for (index, pair) in reach.centerline.windows(2).enumerate() {
                let t = (index as f64 + 0.5) / count as f64;
                segments.push(RiverSegment {
                    start: pair[0],
                    end: pair[1],
                    width: ((reach.width_start_m + (reach.width_end_m - reach.width_start_m) * t)
                        / 1_000.0) as f32,
                    discharge: (reach.discharge_start_m3s
                        + (reach.discharge_end_m3s - reach.discharge_start_m3s) * t)
                        as f32,
                    stream_order: reach.strahler_order,
                });
            }
        }
        segments
    }

    pub fn classify_terminals(&mut self, classify: impl Fn(Point) -> RiverNodeKind) {
        for node in &mut self.nodes {
            if node.outgoing_reach_ids.is_empty() {
                node.kind = classify(node.point);
            }
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        let node_ids = self
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<HashSet<_>>();
        let reach_ids = self
            .reaches
            .iter()
            .map(|reach| reach.id.as_str())
            .collect::<HashSet<_>>();
        if node_ids.len() != self.nodes.len() || reach_ids.len() != self.reaches.len() {
            return Err("river graph contains duplicate stable IDs".to_owned());
        }
        for reach in &self.reaches {
            if !node_ids.contains(reach.from_node_id.as_str())
                || !node_ids.contains(reach.to_node_id.as_str())
                || reach.centerline.len() < 2
                || reach.width_end_m + 1.0e-6 < reach.width_start_m
                || reach.discharge_end_m3s + 1.0e-6 < reach.discharge_start_m3s
            {
                return Err(format!("invalid river reach: {}", reach.id));
            }
        }
        let mut indegree = self
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), 0_usize))
            .collect::<BTreeMap<_, _>>();
        let mut outgoing = BTreeMap::<&str, Vec<&str>>::new();
        for reach in &self.reaches {
            *indegree
                .get_mut(reach.to_node_id.as_str())
                .expect("validated node") += 1;
            outgoing
                .entry(reach.from_node_id.as_str())
                .or_default()
                .push(reach.to_node_id.as_str());
        }
        let mut queue = indegree
            .iter()
            .filter_map(|(id, degree)| (*degree == 0).then_some(*id))
            .collect::<VecDeque<_>>();
        let mut visited = 0;
        while let Some(node) = queue.pop_front() {
            visited += 1;
            for target in outgoing.get(node).into_iter().flatten() {
                let degree = indegree.get_mut(target).expect("validated node");
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(target);
                }
            }
        }
        if visited != self.nodes.len() {
            return Err("river graph contains a directed cycle".to_owned());
        }
        Ok(())
    }
}

fn walk_chain(
    start: usize,
    edges: &[Edge],
    incoming: &[Vec<usize>],
    outgoing: &[Vec<usize>],
    used: &mut [bool],
) -> Vec<usize> {
    let mut result = Vec::new();
    let mut current = start;
    while !used[current] {
        used[current] = true;
        result.push(current);
        let target = edges[current].to;
        if incoming[target].len() != 1 || outgoing[target].len() != 1 {
            break;
        }
        current = outgoing[target][0];
    }
    result
}

fn point_key(point: Point) -> (u32, u32) {
    (point.x.to_bits(), point.y.to_bits())
}

fn stable_hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(start: (f32, f32), end: (f32, f32), discharge: f32) -> RiverSegment {
        RiverSegment {
            start: Point {
                x: start.0,
                y: start.1,
            },
            end: Point { x: end.0, y: end.1 },
            width: discharge * 0.01,
            discharge,
            stream_order: 1,
        }
    }

    #[test]
    fn exact_confluence_becomes_one_shared_node() {
        let graph = RiverGraph::from_segments(
            "map",
            &[
                segment((0.0, 0.0), (1.0, 1.0), 2.0),
                segment((2.0, 0.0), (1.0, 1.0), 3.0),
                segment((1.0, 1.0), (1.0, 2.0), 5.0),
            ],
            false,
        );
        graph.validate().unwrap();
        assert_eq!(
            graph
                .nodes
                .iter()
                .filter(|node| node.kind == RiverNodeKind::Confluence)
                .count(),
            1
        );
    }

    #[test]
    fn graph_round_trips_compatibility_segments() {
        let source = [
            segment((0.0, 0.0), (1.0, 0.0), 1.0),
            segment((1.0, 0.0), (2.0, 0.0), 2.0),
        ];
        let graph = RiverGraph::from_segments("map", &source, false);
        graph.validate().unwrap();
        let restored = graph.to_segments();
        assert_eq!(restored.first().unwrap().start, source[0].start);
        assert_eq!(restored.last().unwrap().end, source[1].end);
    }
}
