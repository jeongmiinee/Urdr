use serde::{Deserialize, Serialize};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChargeCategory {
    #[default]
    All,
    Shape,
    Symbol,
    Religion,
    Object,
    Nature,
    Other,
}

impl ChargeCategory {
    pub const ALL: [Self; 7] = [
        Self::All,
        Self::Shape,
        Self::Symbol,
        Self::Religion,
        Self::Object,
        Self::Nature,
        Self::Other,
    ];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HeraldryShape {
    Rectangle,
    SwallowtailRectangle,
    Square,
    SwallowtailSquare,
    Triangle,
    Shield,
    Circle,
    Diamond,
}

impl HeraldryShape {
    pub const FLAG_SHAPES: [Self; 5] = [
        Self::Rectangle,
        Self::SwallowtailRectangle,
        Self::Square,
        Self::SwallowtailSquare,
        Self::Triangle,
    ];
    pub const EMBLEM_SHAPES: [Self; 5] = [
        Self::Shield,
        Self::Circle,
        Self::Square,
        Self::Triangle,
        Self::Diamond,
    ];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LayerArtwork {
    Solid,
    Vertical,
    Horizontal,
    Diagonal,
    Chevron,
    Cross,
    Checkered,
    Circle,
    Square,
    Triangle,
    Star,
    Diamond,
    Shield,
    Crown,
    Heart,
    IronCross,
    Gear,
    Book,
    Ring,
    HollowSquare,
    HollowTriangle,
    HollowStar,
    HollowDiamond,
    HollowShield,
    CrescentStar,
    UrdrKnot,
    FleurDeLis,
    Lion,
    Eagle,
    Tower,
    Sword,
    Key,
    OakLeaf,
    Sun,
}

impl LayerArtwork {
    pub const PATTERNS: [Self; 7] = [
        Self::Solid,
        Self::Vertical,
        Self::Horizontal,
        Self::Diagonal,
        Self::Chevron,
        Self::Cross,
        Self::Checkered,
    ];
    pub const CHARGES: [Self; 28] = [
        Self::Circle,
        Self::Square,
        Self::Triangle,
        Self::Star,
        Self::Diamond,
        Self::Shield,
        Self::Crown,
        Self::Heart,
        Self::Cross,
        Self::IronCross,
        Self::Gear,
        Self::Book,
        Self::Ring,
        Self::HollowSquare,
        Self::HollowTriangle,
        Self::HollowStar,
        Self::HollowDiamond,
        Self::HollowShield,
        Self::CrescentStar,
        Self::UrdrKnot,
        Self::FleurDeLis,
        Self::Lion,
        Self::Eagle,
        Self::Tower,
        Self::Sword,
        Self::Key,
        Self::OakLeaf,
        Self::Sun,
    ];

    pub fn is_pattern(self) -> bool {
        Self::PATTERNS.contains(&self)
    }

    pub fn charge_category(self) -> ChargeCategory {
        match self {
            Self::Circle
            | Self::Square
            | Self::Triangle
            | Self::Star
            | Self::Diamond
            | Self::Ring
            | Self::HollowSquare
            | Self::HollowTriangle
            | Self::HollowStar
            | Self::HollowDiamond
            | Self::HollowShield => ChargeCategory::Shape,
            Self::Heart | Self::Crown | Self::IronCross | Self::FleurDeLis => {
                ChargeCategory::Symbol
            }
            Self::Cross | Self::CrescentStar => ChargeCategory::Religion,
            Self::Shield | Self::Gear | Self::Book | Self::Tower | Self::Sword | Self::Key => {
                ChargeCategory::Object
            }
            Self::Lion | Self::Eagle | Self::OakLeaf | Self::Sun => ChargeCategory::Nature,
            Self::UrdrKnot => ChargeCategory::Other,
            Self::Solid
            | Self::Vertical
            | Self::Horizontal
            | Self::Diagonal
            | Self::Chevron
            | Self::Checkered => ChargeCategory::Other,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeraldryLayer {
    #[serde(default = "next_layer_id")]
    pub id: String,
    pub artwork: LayerArtwork,
    pub visible: bool,
    pub locked: bool,
    pub color: [u8; 4],
    pub secondary_color: [u8; 4],
    pub scale: f32,
    pub opacity: f32,
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub flip_x: bool,
    pub flip_y: bool,
}

impl HeraldryLayer {
    pub fn new(artwork: LayerArtwork, color: [u8; 4]) -> Self {
        Self {
            id: next_layer_id(),
            artwork,
            visible: true,
            locked: false,
            color,
            secondary_color: [238, 213, 96, 255],
            scale: if artwork.is_pattern() { 100.0 } else { 62.0 },
            opacity: 100.0,
            x: 0.0,
            y: 0.0,
            angle: 0.0,
            flip_x: false,
            flip_y: false,
        }
    }

    pub fn duplicate(&self) -> Self {
        let mut duplicate = self.clone();
        duplicate.id = next_layer_id();
        duplicate
    }
}

fn next_layer_id() -> String {
    static SERIAL: AtomicU64 = AtomicU64::new(1);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos() as u64);
    format!(
        "heraldry-layer-{nanos:016x}-{:08x}",
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeraldryDesign {
    pub shape: HeraldryShape,
    pub layers: Vec<HeraldryLayer>,
}

impl HeraldryDesign {
    pub fn flag() -> Self {
        Self {
            shape: HeraldryShape::Rectangle,
            layers: vec![
                HeraldryLayer::new(LayerArtwork::Solid, [24, 91, 139, 255]),
                HeraldryLayer::new(LayerArtwork::Diagonal, [226, 201, 88, 255]),
                HeraldryLayer::new(LayerArtwork::Star, [245, 248, 251, 255]),
            ],
        }
    }

    pub fn emblem() -> Self {
        Self {
            shape: HeraldryShape::Shield,
            layers: vec![
                HeraldryLayer::new(LayerArtwork::Solid, [24, 91, 139, 255]),
                HeraldryLayer::new(LayerArtwork::Cross, [226, 201, 88, 255]),
                HeraldryLayer::new(LayerArtwork::Crown, [245, 248, 251, 255]),
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_charge_has_one_primary_category_and_all_has_no_duplicates() {
        let unique = LayerArtwork::CHARGES
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), LayerArtwork::CHARGES.len());
        for artwork in LayerArtwork::CHARGES {
            assert_ne!(artwork.charge_category(), ChargeCategory::All);
        }
    }

    #[test]
    fn duplicated_layers_receive_new_stable_ids_without_resetting_transforms() {
        let mut original = HeraldryLayer::new(LayerArtwork::Eagle, [10, 20, 30, 255]);
        original.x = 37.5;
        original.y = -22.0;
        original.angle = 45.0;
        let duplicate = original.duplicate();
        assert_ne!(duplicate.id, original.id);
        assert_eq!(duplicate.x, original.x);
        assert_eq!(duplicate.y, original.y);
        assert_eq!(duplicate.angle, original.angle);
    }
}
