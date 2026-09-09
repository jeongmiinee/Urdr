//! Spherical diagnostics for a sampled mask. No generator or renderer dependency.
use super::*;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

pub(super) struct Grid {
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) radius_km: f64,
    pub(super) points: Vec<PlanetPosition>,
    pub(super) area: Vec<f64>,
    edges: Vec<Vec<(usize, f64)>>,
    // Unique raster boundary arcs (poles have zero boundary length).
    pub(super) arcs: Vec<(usize, usize, f64)>,
}

impl Grid {
    pub(super) fn new(width: usize, height: usize, radius_km: f64) -> Self {
        let count = width * height;
        let points = (0..count + 2)
            .map(|i| grid_position(i, width, height))
            .collect::<Vec<_>>();
        let mut grid = Self {
            width,
            height,
            radius_km,
            points,
            area: vec![0.0; count + 2],
            edges: vec![Vec::new(); count + 2],
            arcs: Vec::new(),
        };
        for y in 0..height {
            let north = FRAC_PI_2 - y as f64 / height as f64 * PI;
            let south = FRAC_PI_2 - (y + 1) as f64 / height as f64 * PI;
            let area = radius_km.powi(2) * TAU / width as f64 * (north.sin() - south.sin());
            for x in 0..width {
                let i = y * width + x;
                grid.area[i] = area;
                let right = y * width + (x + 1) % width;
                grid.connect(i, right);
                grid.arcs.push((i, right, radius_km * PI / height as f64));
                if y + 1 < height {
                    grid.connect(i, i + width);
                    grid.arcs
                        .push((i, i + width, radius_km * TAU / width as f64 * south.cos()));
                }
                if y == 0 {
                    grid.connect(i, count);
                }
                if y + 1 == height {
                    grid.connect(i, count + 1);
                }
            }
        }
        grid
    }

    fn connect(&mut self, i: usize, j: usize) {
        let length = self.points[i].angular_distance_rad(self.points[j]) * self.radius_km;
        self.edges[i].push((j, length));
        self.edges[j].push((i, length));
    }

    pub(super) fn count(&self) -> usize {
        self.width * self.height
    }

    pub(super) fn neighbors(&self, index: usize) -> &[(usize, f64)] {
        &self.edges[index]
    }

    pub(super) fn components(
        &self,
        mask: &[bool],
        triangulated: bool,
    ) -> (Vec<usize>, Vec<Vec<usize>>) {
        let mut labels = vec![usize::MAX; mask.len()];
        let mut groups = Vec::new();
        for start in 0..mask.len() {
            if !mask[start] || labels[start] != usize::MAX {
                continue;
            }
            let id = groups.len();
            let mut group = vec![start];
            labels[start] = id;
            let mut cursor = 0;
            while cursor < group.len() {
                let i = group[cursor];
                cursor += 1;
                let mut visit = |j: usize| {
                    if mask[j] && labels[j] == usize::MAX {
                        labels[j] = id;
                        group.push(j);
                    }
                };
                for &(j, _) in &self.edges[i] {
                    visit(j);
                }
                // One consistent diagonal per quad, with the same polar fan.
                // This is a topology sensitivity check, not an alternate authority.
                if triangulated && i < self.count() {
                    let (x, y) = (i % self.width, i / self.width);
                    if y + 1 < self.height {
                        visit((y + 1) * self.width + (x + 1) % self.width);
                    }
                    if y > 0 {
                        visit((y - 1) * self.width + (x + self.width - 1) % self.width);
                    }
                }
            }
            groups.push(group);
        }
        (labels, groups)
    }

    fn distances(&self, mask: &[bool], starts: &[(usize, f64)], limit: f64) -> Vec<f64> {
        let mut distances = vec![f64::INFINITY; mask.len()];
        let mut queue = BinaryHeap::new();
        for &(i, d) in starts {
            if mask[i] && d < distances[i] {
                distances[i] = d;
                queue.push(Visit(d, i));
            }
        }
        while let Some(Visit(d, i)) = queue.pop() {
            if d > distances[i] || d > limit {
                continue;
            }
            for &(j, length) in &self.edges[i] {
                let next = d + length;
                if mask[j] && next < distances[j] && next <= limit {
                    distances[j] = next;
                    queue.push(Visit(next, j));
                }
            }
        }
        distances
    }

    pub(super) fn coast_distances(&self, mask: &[bool]) -> Vec<f64> {
        let mut starts = Vec::new();
        for i in 0..mask.len() {
            if mask[i] {
                let nearest = self.edges[i]
                    .iter()
                    .filter(|&&(j, _)| !mask[j])
                    .map(|&(_, d)| d * 0.5)
                    .fold(f64::INFINITY, f64::min);
                if nearest.is_finite() {
                    starts.push((i, nearest));
                }
            }
        }
        self.distances(mask, &starts, f64::INFINITY)
    }

    pub(super) fn morphology(&self, mask: &[bool], widths: &[f64]) -> Value {
        let (parents, groups) = self.components(mask, false);
        let distances = self.coast_distances(mask);
        let mut levels = Vec::new();
        for &width in widths {
            let radius = width * 0.5;
            let core = (0..mask.len())
                .map(|i| mask[i] && distances[i] >= radius)
                .collect::<Vec<_>>();
            let (_, core_groups) = self.components(&core, false);
            let mut cores_per_parent = vec![0_usize; groups.len()];
            for g in &core_groups {
                // Zero-area pole-only fragments do not count as landmasses.
                if g.iter().any(|&i| self.area[i] > 0.0) {
                    cores_per_parent[parents[g[0]]] += 1;
                }
            }
            let splits: usize = cores_per_parent.iter().map(|n| n.saturating_sub(1)).sum();
            let starts = (0..mask.len())
                .filter(|&i| core[i])
                .map(|i| (i, 0.0))
                .collect::<Vec<_>>();
            let from_core = self.distances(mask, &starts, f64::INFINITY);
            // Geodesic opening residual. A residual attached to a surviving core,
            // reaching >= 3 times its estimated width, is a peninsula proxy.
            let residual = (0..mask.len())
                .map(|i| mask[i] && from_core[i] > radius && from_core[i].is_finite())
                .collect::<Vec<_>>();
            let (_, residual_groups) = self.components(&residual, false);
            let mut peninsulas = Vec::new();
            for g in residual_groups {
                let area: f64 = g.iter().map(|&i| self.area[i]).sum();
                let length = g.iter().map(|&i| from_core[i] - radius).fold(0.0, f64::max);
                let local_width = g.iter().map(|&i| distances[i] * 2.0).fold(0.0, f64::max);
                if area > 0.0 && local_width > 0.0 && length / local_width >= 3.0 {
                    peninsulas.push(json!({"area_km2":area,"reach_km":length,"width_proxy_km":local_width,"length_width_ratio":length/local_width}));
                }
            }
            levels.push(json!({
                "width_upper_bound_km":width,
                "core_split_excess":splits,
                "parents_without_core":cores_per_parent.iter().filter(|&&n| n==0).count(),
                "core_components":cores_per_parent.iter().sum::<usize>(),
                "long_thin_peninsula_proxy_count":peninsulas.len(),
                "long_thin_peninsula_proxies":peninsulas,
            }));
        }
        json!({"method":"geodesic erosion split counts; opening residual reach/width >= 3; width bounds, not skeleton widths", "levels":levels})
    }
}

#[derive(Clone, Copy)]
struct Visit(f64, usize);
impl PartialEq for Visit {
    fn eq(&self, other: &Self) -> bool {
        self.0.to_bits() == other.0.to_bits() && self.1 == other.1
    }
}
impl Eq for Visit {}
impl Ord for Visit {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .total_cmp(&self.0)
            .then_with(|| other.1.cmp(&self.1))
    }
}
impl PartialOrd for Visit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn ratio(numerator: f64, denominator: f64) -> Option<f64> {
    (denominator > 0.0)
        .then(|| numerator / denominator)
        .filter(|v| v.is_finite())
}

fn elongation(grid: &Grid, group: &[usize]) -> Option<f64> {
    let area: f64 = group.iter().map(|&i| grid.area[i]).sum();
    if area == 0.0 {
        return None;
    }
    let mut mean = [0.0; 3];
    for &i in group {
        let p = grid.points[i].components();
        for j in 0..3 {
            mean[j] += p[j] * grid.area[i] / area;
        }
    }
    let mut cov = [[0.0; 3]; 3];
    for &i in group {
        let p = grid.points[i].components();
        for j in 0..3 {
            for k in 0..3 {
                cov[j][k] += (p[j] - mean[j]) * (p[k] - mean[k]) * grid.area[i] / area;
            }
        }
    }
    // Symmetric 3x3 Jacobi eigensolver; chordal PCA avoids a longitude seam.
    for _ in 0..24 {
        let (p, q) = [(0, 1), (0, 2), (1, 2)]
            .into_iter()
            .max_by(|&(a, b), &(c, d)| cov[a][b].abs().total_cmp(&cov[c][d].abs()))
            .unwrap();
        if cov[p][q].abs() < 1e-14 {
            break;
        }
        let angle = 0.5 * (2.0 * cov[p][q]).atan2(cov[q][q] - cov[p][p]);
        let (s, c) = angle.sin_cos();
        let mut rot = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        rot[p][p] = c;
        rot[q][q] = c;
        rot[p][q] = s;
        rot[q][p] = -s;
        let mut next = [[0.0; 3]; 3];
        for (i, row) in next.iter_mut().enumerate() {
            for (j, value) in row.iter_mut().enumerate() {
                for a in 0..3 {
                    for b in 0..3 {
                        *value += rot[a][i] * cov[a][b] * rot[b][j];
                    }
                }
            }
        }
        cov = next;
    }
    let mut eigen = [cov[0][0], cov[1][1], cov[2][2]];
    eigen.sort_by(|a, b| b.total_cmp(a));
    ratio(eigen[0], eigen[1]).map(f64::sqrt)
}

pub(super) fn covariance(
    grid: &Grid,
    samples: &[Components],
    config: &PlanetGenerationConfig,
) -> Value {
    let total: f64 = grid.area.iter().sum();
    let mut mean = [0.0; 5];
    let values = samples
        .iter()
        .map(|s| {
            let [c, d, k, b] = s.weighted(config);
            [c, d, k, b, s.raw_h(config) as f64]
        })
        .collect::<Vec<_>>();
    for (i, values) in values.iter().enumerate() {
        for j in 0..5 {
            mean[j] += values[j] * grid.area[i] / total;
        }
    }
    let mut cov = [[0.0; 5]; 5];
    for (i, values) in values.iter().enumerate() {
        for j in 0..5 {
            for k in 0..5 {
                cov[j][k] += (values[j] - mean[j]) * (values[k] - mean[k]) * grid.area[i] / total;
            }
        }
    }
    let corr = (0..5)
        .map(|j| {
            (0..5)
                .map(|k| ratio(cov[j][k], (cov[j][j] * cov[k][k]).sqrt()))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    json!({"fields":["weighted_C","weighted_D","weighted_K","weighted_B","raw_H"],"area_weighted_mean":mean,"covariance":cov,"correlation":corr})
}

pub(super) fn measure(
    grid: &Grid,
    mask: &[bool],
    reference: &[bool],
    samples: &[Components],
) -> (Value, Vec<usize>) {
    let count = grid.count();
    let total: f64 = grid.area.iter().sum();
    let land_area: f64 = (0..count).filter(|&i| mask[i]).map(|i| grid.area[i]).sum();
    let (labels, groups) = grid.components(mask, false);
    let (_, triangle_groups) = grid.components(mask, true);
    let mut perimeters = vec![0.0; groups.len()];
    let mut coast_distance_sum = 0.0;
    let mut coast_distances = Vec::new();
    let mut coast_close = 0.0;
    let mut mixed_crust_coast = 0.0;
    let mut perimeter = 0.0;
    for &(i, j, length) in &grid.arcs {
        if mask[i] != mask[j] {
            perimeter += length;
            perimeters[labels[if mask[i] { i } else { j }]] += length;
            let distance = (samples[i].boundary_distance_rad + samples[j].boundary_distance_rad)
                * 0.5
                * grid.radius_km;
            coast_distance_sum += distance * length;
            coast_distances.push((distance, length));
            if distance < 100.0 {
                coast_close += length;
            }
            if samples[i].crust != samples[j].crust {
                mixed_crust_coast += length;
            }
        }
    }
    coast_distances.sort_by(|a, b| a.0.total_cmp(&b.0));
    let coast_quantile = |q: f64| -> Option<f64> {
        let mut accum = 0.0;
        for &(d, p) in &coast_distances {
            accum += p;
            if accum >= perimeter * q {
                return Some(d);
            }
        }
        None
    };
    let mut components = groups
        .iter()
        .enumerate()
        .filter_map(|(id, group)| {
            let area: f64 = group.iter().map(|&i| grid.area[i]).sum();
            if area == 0.0 {
                return None;
            }
            let p = perimeters[id];
            Some(
                json!({"id":id,"cells":group.iter().filter(|&&i|i<count).count(),"area_km2":area,
            "fraction_of_land":ratio(area,land_area),"fraction_of_planet":area/total,
            "perimeter_km":p,"perimeter_area_km_inverse":ratio(p,area),
            "spherical_compactness":ratio(4.0*PI*area-area*area/grid.radius_km.powi(2),p*p),
            "chordal_pca_elongation":elongation(grid,group)}),
            )
        })
        .collect::<Vec<_>>();
    components.sort_by(|a, b| {
        b["area_km2"]
            .as_f64()
            .unwrap()
            .total_cmp(&a["area_km2"].as_f64().unwrap())
    });
    let mut distribution = Vec::new();
    for (lo, hi) in [
        (0.0, 1e4),
        (1e4, 1e5),
        (1e5, 1e6),
        (1e6, 1e7),
        (1e7, f64::INFINITY),
    ] {
        let selected = components
            .iter()
            .filter(|c| {
                let a = c["area_km2"].as_f64().unwrap();
                a >= lo && a < hi
            })
            .collect::<Vec<_>>();
        distribution.push(json!({"lower_km2":lo,"upper_km2":if hi.is_finite(){Some(hi)}else{None},"count":selected.len(),"area_km2":selected.iter().map(|c|c["area_km2"].as_f64().unwrap()).sum::<f64>()}));
    }
    let micro = components
        .iter()
        .filter(|c| c["cells"].as_u64().unwrap() <= 3)
        .collect::<Vec<_>>();
    let micro_area: f64 = micro.iter().map(|c| c["area_km2"].as_f64().unwrap()).sum();
    let mut polar = Vec::new();
    for latitude in [60.0_f64, 75.0] {
        for north in [true, false] {
            let edge = latitude.to_radians().sin();
            let cap = (0..count)
                .filter(|&i| {
                    if north {
                        grid.points[i].components()[2] > edge
                    } else {
                        grid.points[i].components()[2] < -edge
                    }
                })
                .collect::<Vec<_>>();
            polar.push(json!({"latitude_abs_deg":latitude,"north":north,"land_fraction":ratio(cap.iter().filter(|&&i|mask[i]).map(|&i|grid.area[i]).sum(),cap.iter().map(|&i|grid.area[i]).sum())}));
        }
    }
    let conditional = |continental: bool| {
        let indices = (0..count)
            .filter(|&i| {
                if continental {
                    samples[i].crust == 0.58
                } else {
                    samples[i].crust == -0.52
                }
            })
            .collect::<Vec<_>>();
        ratio(
            indices
                .iter()
                .filter(|&&i| mask[i])
                .map(|&i| grid.area[i])
                .sum(),
            indices.iter().map(|&i| grid.area[i]).sum(),
        )
    };
    let flip: f64 = (0..count)
        .filter(|&i| mask[i] != reference[i])
        .map(|i| grid.area[i])
        .sum();
    let union: f64 = (0..count)
        .filter(|&i| mask[i] || reference[i])
        .map(|i| grid.area[i])
        .sum();
    let intersection: f64 = (0..count)
        .filter(|&i| mask[i] && reference[i])
        .map(|i| grid.area[i])
        .sum();
    let water = mask.iter().map(|&v| !v).collect::<Vec<_>>();
    let widths = [160.0, 320.0, 640.0];
    let metrics = json!({
        "ocean_unweighted":(0..count).filter(|&i|!mask[i]).count() as f64/count as f64,
        "ocean_spherical":1.0-land_area/total,"land_area_km2":land_area,
        "land_components":components.len(),
        "land_components_triangle_sensitivity":triangle_groups.iter().filter(|g|g.iter().any(|&i|grid.area[i]>0.0)).count(),
        "largest_land_fraction":components.first().and_then(|c|c["fraction_of_land"].as_f64()),
        "second_land_fraction":components.get(1).and_then(|c|c["fraction_of_land"].as_f64()),
        "largest_planet_fraction":components.first().and_then(|c|c["fraction_of_planet"].as_f64()),
        "micro_islands_max_cells":3,"micro_islands":micro.len(),"micro_island_area_km2":micro_area,
        "micro_island_fraction_of_land":ratio(micro_area,land_area),
        "area_size_distribution_all_components":distribution,
        "coast_perimeter_km":perimeter,"perimeter_area_km_inverse":ratio(perimeter,land_area),
        "coast_boundary_mean_km":ratio(coast_distance_sum,perimeter),
        "coast_boundary_p50_km":coast_quantile(0.5),"coast_boundary_p90_km":coast_quantile(0.9),
        "coast_within_100km_boundary_fraction":ratio(coast_close,perimeter),
        "coast_crossing_mixed_crust_fraction":ratio(mixed_crust_coast,perimeter),
        "polar":polar,"land_given_continental":conditional(true),"land_given_oceanic":conditional(false),
        "mask_flip_planet_area_fraction":flip/total,"land_jaccard":ratio(intersection,union),
        "seam_adjacent_mask_transitions":(0..grid.height).filter(|&y|mask[y*grid.width]!=mask[y*grid.width+grid.width-1]).count(),
        "north_pole_land":mask[count],"south_pole_land":mask[count+1],
        "land_necks":grid.morphology(mask,&widths),"water_straits":grid.morphology(&water,&widths),
        "components_descending_area":components,
    });
    (metrics, labels)
}

#[test]
fn planet_landmass_spherical_area_perimeter_and_pole_topology() {
    let grid = Grid::new(32, 16, 1.0);
    assert!((grid.area.iter().sum::<f64>() - 4.0 * PI).abs() < 1e-12);
    let mut mask = (0..grid.count() + 2)
        .map(|i| grid.points[i].components()[2] > 0.0)
        .collect::<Vec<_>>();
    let perimeter: f64 = grid
        .arcs
        .iter()
        .filter(|&&(i, j, _)| mask[i] != mask[j])
        .map(|&(_, _, p)| p)
        .sum();
    assert!((perimeter - TAU).abs() < 1e-12);
    assert_eq!(grid.components(&mask, false).1.len(), 1);
    mask.fill(false);
    mask[0] = true;
    mask[16] = true;
    assert_eq!(grid.components(&mask, false).1.len(), 2);
    mask[grid.count()] = true;
    assert_eq!(grid.components(&mask, false).1.len(), 1);
    mask.fill(false);
    mask[5 * 32] = true;
    mask[5 * 32 + 31] = true;
    assert_eq!(grid.components(&mask, false).1.len(), 1);
}

#[test]
fn planet_landmass_width_diagnostic_detects_synthetic_neck() {
    let grid = Grid::new(64, 32, 1000.0);
    let mut mask = vec![false; grid.count() + 2];
    for y in 10..22 {
        for x in 10..22 {
            mask[y * 64 + x] = true;
        }
        for x in 30..42 {
            mask[y * 64 + x] = true;
        }
    }
    for x in 22..30 {
        mask[15 * 64 + x] = true;
    }
    assert_eq!(grid.components(&mask, false).1.len(), 1);
    let morphology = grid.morphology(&mask, &[300.0]);
    assert_eq!(morphology["levels"][0]["core_split_excess"], 1);
    // Longitude rotation must preserve connectivity, exact cell area and widths.
    let mut shifted = mask.clone();
    for y in 0..32 {
        for x in 0..64 {
            shifted[y * 64 + (x + 40) % 64] = mask[y * 64 + x];
        }
    }
    assert_eq!(
        grid.morphology(&shifted, &[300.0])["levels"][0]["core_split_excess"],
        1
    );
}
